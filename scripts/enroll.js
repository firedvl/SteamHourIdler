import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from '../src/logger.js';
import { writeTokenAtomic } from '../src/token-store.js';

function waitForAuthentication(session) {
	let cancel;
	const promise = new Promise((resolve, reject) => {
		const cleanup = () => {
			session.removeListener('authenticated', onAuthenticated);
			session.removeListener('timeout', onTimeout);
			session.removeListener('error', onError);
		};
		const onAuthenticated = () => {
			cleanup();
			resolve(session.refreshToken);
		};
		const onTimeout = () => {
			cleanup();
			reject(new Error('Steam enrollment timed out'));
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		cancel = cleanup;
		session.once('authenticated', onAuthenticated);
		session.once('timeout', onTimeout);
		session.once('error', onError);
	});
	return { promise, cancel };
}

async function runEnrollment({
	LoginSessionClass,
	platformType,
	persistence,
	guardTypes,
	accountName,
	password,
	tokenFile,
	readGuardCode,
	writeToken,
	logger,
}) {
	const session = new LoginSessionClass(platformType, {
		machineId: true,
		machineFriendlyName: 'steam-idler',
	});

	const authenticated = waitForAuthentication(session);
	authenticated.promise.catch(() => {});
	try {
		const response = await session.startWithCredentials({
			accountName,
			password,
			persistence,
		});

		if (response.actionRequired) {
			const actions = response.validActions ?? [];
			const canApproveInApp = actions.some(
				(action) => action.type === guardTypes.DeviceConfirmation,
			);
			const canApproveByEmail = actions.some(
				(action) => action.type === guardTypes.EmailConfirmation,
			);
			const canEnterDeviceCode = actions.some(
				(action) => action.type === guardTypes.DeviceCode,
			);
			const canEnterEmailCode = actions.some(
				(action) => action.type === guardTypes.EmailCode,
			);

			if (canApproveInApp) {
				logger.info('mobile_approval_required', {
					message: 'Approve the login in the Steam mobile app.',
				});
			} else if (canApproveByEmail) {
				logger.info('email_approval_required', {
					message: 'Approve the Steam login using the email Steam sent you.',
				});
			} else if (canEnterDeviceCode || canEnterEmailCode) {
				const type = canEnterDeviceCode ? 'device' : 'email';
				const code = readGuardCode({ type });
				await session.submitSteamGuardCode(code);
			} else {
				const offeredActions = actions.map((action) => ({
					type: action.type,
					detail: action.detail,
				}));
				session.cancelLoginAttempt?.();
				throw new Error(
					`Steam did not offer a supported Steam Guard action: ${JSON.stringify(offeredActions)}`,
				);
			}
		}

		const refreshToken = await authenticated.promise;
		if (!refreshToken) throw new Error('Steam authenticated without issuing a refresh token');
		await writeToken(tokenFile, refreshToken);
		logger.info('enrollment_complete');
	} catch (error) {
		authenticated.cancel();
		throw error;
	}
}

async function main() {
	const logger = createLogger();
	let accountName;
	let password;

	try {
		const tokenFile = process.env.STEAM_TOKEN_FILE;
		if (!tokenFile || !path.isAbsolute(tokenFile)) {
			throw new Error('STEAM_TOKEN_FILE must be an absolute path');
		}

		const [{ LoginSession, EAuthTokenPlatformType, ESessionPersistence, EAuthSessionGuardType }, readlineModule] = await Promise.all([import('steam-session'), import('readline-sync')]);
		const readlineSync = readlineModule.default ?? readlineModule;
		accountName = readlineSync.question('Steam account name: ');
		password = readlineSync.question('Steam password: ', { hideEchoBack: true });

		await runEnrollment({
			LoginSessionClass: LoginSession,
			platformType: EAuthTokenPlatformType.SteamClient,
			persistence: ESessionPersistence.Persistent,
			guardTypes: EAuthSessionGuardType,
			accountName,
			password,
			tokenFile,
			readGuardCode: ({ type }) => readlineSync.question(
				type === 'email' ? 'Steam Guard email code: ' : 'Steam Guard mobile code: ',
				{ hideEchoBack: true },
			),
			writeToken: writeTokenAtomic,
			logger,
		});
	} catch (error) {
		logger.error('enrollment_failed', { error });
		process.exitCode = 1;
	} finally {
		accountName = undefined;
		password = undefined;
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	await main();
}

export { runEnrollment };
