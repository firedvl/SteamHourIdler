const AUTH_REQUIRED_EXIT_CODE = 78;
const RECONNECT_WATCHDOG_MS = 10 * 60 * 1_000;

const AUTHENTICATION_RESULTS = new Set([
	'InvalidPassword',
	'Expired',
	'Revoked',
	'AccountLogonDenied',
	'AccountLoginDeniedNeedTwoFactor',
	'TwoFactorCodeMismatch',
	'AccountDisabled',
	'AccountLocked',
	'AccountLockedDown',
	'AccountDeleted',
	'AccountHasBeenDeleted',
	'AccountNotFound',
	'AccountLogonDeniedNeedTwoFactorCode',
	'AccountLogonDeniedNoMail',
	'AccountLogonDeniedNoMailSent',
	'AccountLogonDeniedVerifiedEmailRequired',
	'CannotUseOldPassword',
	'Disabled',
	'ExpiredLoginAuthCode',
	'IllegalPassword',
	'PasswordNotSet',
	'PasswordUnset',
	'Banned',
	'Suspended',
	'IPBanned',
	'ParentalControlRestricted',
	'IPLoginRestrictionFailed',
	'InvalidLoginAuthCode',
	'RestrictedDevice',
	'AccessDenied',
	'RegionLocked',
	'RequirePasswordReEntry',
]);

const RETRYABLE_RESULTS = new Set([
	'NoConnection',
	'LoggedInElsewhere',
	'Busy',
	'Timeout',
	'ServiceUnavailable',
	'ConnectFailed',
	'HandshakeFailed',
	'IOFailure',
	'RemoteDisconnect',
	'LogonSessionReplaced',
	'ServiceReadOnly',
	'TryAnotherCM',
	'RemoteCallFailed',
	'BadResponse',
	'UnexpectedError',
	'RateLimitExceeded',
	'AccountLoginDeniedThrottle',
	'AlreadyLoggedInElsewhere',
]);

function isAuthenticationError(error, resultName) {
	return AUTHENTICATION_RESULTS.has(resultName) || /refresh token|authentication|steam guard/i.test(error?.message ?? '');
}

function createIdler({
	client,
	games,
	retry,
	logger,
	writeToken,
	heartbeatMs,
	setIntervalFn = setInterval,
	clearIntervalFn = clearInterval,
	setReconnectTimeoutFn = setTimeout,
	clearReconnectTimeoutFn = clearTimeout,
	reconnectWatchdogMs = RECONNECT_WATCHDOG_MS,
	onFatal,
	notifyAuthenticationRequired,
	eresultNames = {},
	personaOnline,
	uptime = process.uptime,
	tokenWriteMaxDelayMs = 30 * 60 * 1_000,
	tokenShutdownFlushMs = 30_000,
	delayFn = (delayMs) => new Promise((resolve) => {
		const timer = setTimeout(resolve, delayMs);
		timer.unref?.();
	}),
}) {
	let state = 'starting';
	let blocked = false;
	let refreshToken;
	let heartbeatTimer;
	let reconnectWatchdogTimer;
	let stopped = false;
	let tokenWriteWorker = Promise.resolve();
	let tokenWriterRunning = false;
	let pendingRefreshToken;
	let connected = false;
	let tokenPersistenceDegraded = false;
	let pendingTokenWrites = 0;
	let wakeForShutdown;
	let expireShutdownFlush;
	let shutdownFlushTimer;
	let shutdownExpired = false;
	const shutdownFlushExpired = new Promise((resolve) => { expireShutdownFlush = resolve; });
	const shutdownWake = new Promise((resolve) => { wakeForShutdown = resolve; });

	function setState(nextState) {
		state = nextState;
	}

	function resultNameFor(error) {
		return error?.eresult === undefined ? undefined : eresultNames[error.eresult];
	}

	function clearReconnectWatchdog() {
		if (reconnectWatchdogTimer === undefined) return;
		clearReconnectTimeoutFn(reconnectWatchdogTimer);
		reconnectWatchdogTimer = undefined;
	}

	function armReconnectWatchdog() {
		if (reconnectWatchdogTimer !== undefined) return;
		reconnectWatchdogTimer = setReconnectTimeoutFn(() => {
			reconnectWatchdogTimer = undefined;
			if (stopped || connected || state !== 'reconnecting') return;
			logger.error('reconnect_watchdog_expired', { timeoutMs: reconnectWatchdogMs });
			onFatal(1);
		}, reconnectWatchdogMs);
		reconnectWatchdogTimer?.unref?.();
	}

	function logOn() {
		if (stopped) return;
		try {
			client.logOn({ refreshToken });
		} catch (error) {
			handleError(error);
		}
	}

	function requireEnrollment(reason, fields = {}) {
		if (state === 'authentication_required') return;
		setState('authentication_required');
		connected = false;
		clearReconnectWatchdog();
		retry.cancel();
		logger.error('authentication_required', { reason, ...fields });
		if (notifyAuthenticationRequired !== undefined) {
			void notifyAuthenticationRequired().catch(() => {
				logger.warn('authentication_notification_failed');
			});
		}
		onFatal(AUTH_REQUIRED_EXIT_CODE);
	}

	function handleError(error) {
		if (stopped) return;
		connected = false;
		clearReconnectWatchdog();
		const resultName = resultNameFor(error);
		const fields = {
			message: error?.message ?? String(error),
			...(error?.eresult === undefined ? {} : { eresult: error.eresult }),
			...(resultName === undefined ? {} : { resultName }),
		};

		const hasEResult = error?.eresult !== undefined;
		if (isAuthenticationError(error, resultName) || (hasEResult && !RETRYABLE_RESULTS.has(resultName))) {
			requireEnrollment('steam_error', fields);
			return;
		}

		setState('reconnecting');
		const delayMs = retry.schedule(logOn);
		if (delayMs === null) {
			logger.warn('retry_already_scheduled', fields);
			return;
		}
		logger.warn('retry_scheduled', { ...fields, delayMs });
	}

	async function runTokenWriter() {
		tokenWriterRunning = true;
		let attempt = 0;
		while (pendingRefreshToken !== undefined && (!stopped || !shutdownExpired)) {
			const token = pendingRefreshToken;
			try {
				const writeResult = await Promise.race([
					writeToken(token).then(() => true),
					shutdownFlushExpired.then(() => false),
				]);
				if (!writeResult) break;
				if (pendingRefreshToken === token) {
					pendingRefreshToken = undefined;
					pendingTokenWrites = 0;
					tokenPersistenceDegraded = false;
				}
				attempt = 0;
				logger.info('refresh_token_saved');
			} catch (error) {
				tokenPersistenceDegraded = true;
				attempt = pendingRefreshToken === token ? attempt + 1 : 1;
				const delayMs = Math.min(1_000 * (2 ** Math.min(attempt - 1, 20)), tokenWriteMaxDelayMs);
				logger.warn('refresh_token_save_retry', { attempt, delayMs, error });
				if (stopped) {
					await Promise.race([
						delayFn(delayMs, { referenced: true }),
						shutdownFlushExpired,
					]);
				} else {
					await Promise.race([delayFn(delayMs), shutdownWake]);
				}
			}
		}
		tokenWriterRunning = false;
		if (shutdownFlushTimer !== undefined) clearTimeout(shutdownFlushTimer);
	}

	function persistReplacement(token) {
		refreshToken = token;
		pendingRefreshToken = token;
		pendingTokenWrites = 1;
		if (!tokenWriterRunning) tokenWriteWorker = runTokenWriter();
	}

	client.on('loggedOn', () => {
		if (stopped) return;
		connected = true;
		clearReconnectWatchdog();
		retry.reset();
		blocked = false;
		client.setPersona(personaOnline);
		client.gamesPlayed(games);
		setState('playing');
		logger.info('logged_on', { state, gameCount: games.length });
	});

	client.on('disconnected', (eresult, message) => {
		if (stopped) return;
		connected = false;
		setState('reconnecting');
		logger.warn('disconnected', { eresult, message, state });
		armReconnectWatchdog();
	});

	client.on('error', handleError);

	client.on('steamGuard', () => {
		if (stopped) return;
		requireEnrollment('steam_guard_requested');
	});

	client.on('playingState', (isBlocked, playingApp) => {
		if (stopped) return;
		const wasBlocked = blocked;
		blocked = Boolean(isBlocked);
		if (blocked) {
			setState('blocked');
			logger.warn('playing_blocked', { state, playingApp });
			return;
		}

		setState('playing');
		logger.info('playing_confirmed', { state, playingApp });
		if (wasBlocked) client.gamesPlayed(games);
	});

	client.on('refreshToken', (token) => {
		if (stopped) return;
		persistReplacement(token);
	});

	function emitHeartbeat() {
		logger.info('heartbeat', {
			state,
			connected,
			blocked,
			gameCount: games.length,
			uptimeSeconds: Math.floor(uptime()),
			tokenPersistenceDegraded,
			pendingTokenWrites,
		});
	}

	return {
		get state() {
			return state;
		},

		connect(token) {
			refreshToken = token;
			setState('connecting');
			logger.info('connecting', { state, gameCount: games.length });
			heartbeatTimer = setIntervalFn(emitHeartbeat, heartbeatMs);
			logOn();
		},

		stop() {
			if (stopped) return;
			stopped = true;
			connected = false;
			setState('stopping');
			clearReconnectWatchdog();
			retry.cancel();
			if (heartbeatTimer !== undefined) clearIntervalFn(heartbeatTimer);
			try {
				client.logOff();
			} catch (error) {
				logger.warn('logoff_failed', { error });
			}
			logger.info('stopped', { state });
			if (pendingRefreshToken !== undefined) {
				shutdownFlushTimer = setTimeout(() => {
					shutdownExpired = true;
					expireShutdownFlush();
					logger.error('refresh_token_shutdown_flush_expired', {
						timeoutMs: tokenShutdownFlushMs,
					});
				}, tokenShutdownFlushMs);
			}
			wakeForShutdown();
			return tokenWriteWorker;
		},

		drainTokenWrites() {
			return tokenWriteWorker;
		},
	};
}

export { createIdler, AUTH_REQUIRED_EXIT_CODE };
