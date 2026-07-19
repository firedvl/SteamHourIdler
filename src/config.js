import path from 'node:path';

import { OperatorActionRequiredError } from './errors.js';

function parseGames(value) {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new OperatorActionRequiredError('STEAM_GAMES is required');
	}

	const parts = value.split(',').map((part) => part.trim());
	if (parts.some((part) => !/^\d+$/.test(part))) {
		throw new OperatorActionRequiredError('STEAM_GAMES must contain positive integer AppIDs');
	}

	const games = parts.map(Number);
	if (games.some((appid) => !Number.isSafeInteger(appid) || appid <= 0)) {
		throw new OperatorActionRequiredError('STEAM_GAMES must contain positive integer AppIDs');
	}
	if (new Set(games).size !== games.length) {
		throw new OperatorActionRequiredError('STEAM_GAMES must not contain duplicate AppIDs');
	}
	if (games.length > 32) {
		throw new OperatorActionRequiredError('STEAM_GAMES must contain at most 32 AppIDs');
	}

	return games;
}

function requireAbsolutePath(env, key) {
	const value = env[key];
	if (!value || !path.isAbsolute(value)) {
		throw new OperatorActionRequiredError(`${key} must be an absolute path`);
	}
	return value;
}

function parseDiscordWebhookUrl(value) {
	if (value === undefined || value.trim() === '') return undefined;

	let url;
	try {
		url = new URL(value);
	} catch {
		throw new OperatorActionRequiredError('DISCORD_WEBHOOK_URL must be a valid Discord webhook URL');
	}

	if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || !/^\/api\/webhooks\/[^/]+\/[^/]+\/?$/.test(url.pathname)) {
		throw new OperatorActionRequiredError('DISCORD_WEBHOOK_URL must be a valid Discord webhook URL');
	}

	return url.toString();
}

function loadConfig(env = process.env) {
	const heartbeatSeconds = env.STEAM_HEARTBEAT_SECONDS === undefined ? 300 : Number(env.STEAM_HEARTBEAT_SECONDS);

	if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds <= 0) {
		throw new OperatorActionRequiredError('STEAM_HEARTBEAT_SECONDS must be a positive integer');
	}

	return {
		games: parseGames(env.STEAM_GAMES),
		tokenFile: requireAbsolutePath(env, 'STEAM_TOKEN_FILE'),
		dataDir: requireAbsolutePath(env, 'STEAM_DATA_DIR'),
		heartbeatMs: heartbeatSeconds * 1000,
		discordWebhookUrl: parseDiscordWebhookUrl(env.DISCORD_WEBHOOK_URL),
	};
}

export { parseGames, parseDiscordWebhookUrl, loadConfig };
