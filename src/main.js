import path from 'node:path';
import { fileURLToPath } from 'node:url';

import SteamUser from 'steam-user';

import { loadConfig } from './config.js';
import { OperatorActionRequiredError } from './errors.js';
import { createIdler } from './idler.js';
import { createLogger } from './logger.js';
import { createAuthenticationNotifier } from './notifier.js';
import { RetryController } from './retry.js';
import { readToken, validateRefreshToken, writeTokenAtomic } from './token-store.js';

async function runService({
	env = process.env,
	SteamUserClass = SteamUser,
	logger = createLogger(),
	processRef = process,
	readTokenFn = readToken,
	validateTokenFn = validateRefreshToken,
	writeTokenFn = writeTokenAtomic,
	createIdlerFn = createIdler,
	createNotifierFn = createAuthenticationNotifier,
} = {}) {
	const config = loadConfig(env);
	let refreshToken;
	try {
		refreshToken = await readTokenFn(config.tokenFile);
	} catch (error) {
		if (error instanceof OperatorActionRequiredError
		|| ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) {
		throw new OperatorActionRequiredError('Refresh token is unavailable; run enrollment', { cause: error });
		}
		throw error;
	}
	validateTokenFn(refreshToken);
	const client = new SteamUserClass({
		autoRelogin: true,
		dataDirectory: config.dataDir,
		promptSteamGuardCode: false,
		renewRefreshTokens: true,
	});
	const retry = new RetryController();
	const notifyAuthenticationRequired = createNotifierFn({ webhookUrl: config.discordWebhookUrl });
	let stopping = false;
	let shutdownPromise;
	let idler;

	function shutdown(code, reason) {
		if (code !== 0 || processRef.exitCode === undefined) processRef.exitCode = code;
		if (stopping) return shutdownPromise;
		stopping = true;
		logger.info('shutdown_requested', { reason, exitCode: code });
		shutdownPromise = Promise.resolve(idler.stop()).catch((error) => {
		logger.error('shutdown_flush_failed', { error });
		processRef.exitCode = 1;
		});
		return shutdownPromise;
	}

	idler = createIdlerFn({
		client,
		games: config.games,
		retry,
		logger,
		writeToken: (token) => writeTokenFn(config.tokenFile, token),
		notifyAuthenticationRequired,
		heartbeatMs: config.heartbeatMs,
		onFatal: (code) => shutdown(code, 'fatal_state'),
		eresultNames: SteamUserClass.EResult,
		personaOnline: SteamUserClass.EPersonaState.Online,
		uptime: () => processRef.uptime(),
	});

	processRef.on('SIGINT', async () => { await shutdown(0, 'SIGINT'); });
	processRef.on('SIGTERM', async () => { await shutdown(0, 'SIGTERM'); });
	processRef.on('uncaughtExceptionMonitor', (error, origin) => {
		logger.error('uncaught_exception', { error, origin });
	});
	processRef.on('unhandledRejection', (reason) => {
		logger.error('unhandled_rejection', {
		error: reason instanceof Error ? reason : new Error(String(reason)),
		});
		shutdown(1, 'unhandled_rejection');
	});

	idler.connect(refreshToken);
	return { idler, shutdown };
}

async function runMain({
	logger = createLogger(),
	processRef = process,
	runServiceFn = runService,
} = {}) {
	try {
		await runServiceFn({ logger, processRef });
	} catch (error) {
		logger.error('startup_failed', { error });
		processRef.exitCode = error instanceof OperatorActionRequiredError ? 78 : 1;
	}
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	await runMain();
}


export { runService, runMain };
