import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';

import { OperatorActionRequiredError } from './errors.js';

function validateToken(token) {
	if (typeof token !== 'string' || token.trim() === '' || /[\r\n]/.test(token)) {
		throw new OperatorActionRequiredError('Refresh token must be one non-empty line');
	}
	return token.trim();
}

function validateRefreshToken(token, now = Date.now) {
	const validated = validateToken(token);
	const parts = validated.split('.');
	let payload;
	try {
		if (parts.length !== 3 || parts.some((part) => part === '')) throw new Error('invalid shape');
		payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch (error) {
		throw new OperatorActionRequiredError('Refresh token is not a valid JWT', { cause: error });
	}

	const audience = Array.isArray(payload.aud) ? payload.aud : [];
	const validClaims = payload.iss === 'steam'
		&& /^\d{17}$/.test(payload.sub ?? '')
		&& audience.includes('client')
		&& audience.includes('derive')
		&& Number.isFinite(payload.iat)
		&& Number.isFinite(payload.exp)
		&& payload.exp > Math.floor(now() / 1000);
	if (!validClaims) {
		throw new OperatorActionRequiredError('Refresh token has invalid or expired SteamClient claims');
	}

	return validated;
}

async function readToken(filePath, fsApi = fs) {
	const token = await fsApi.readFile(filePath, 'utf8');
	return validateToken(token.trim());
}

async function writeTokenAtomic(filePath, token, fsApi = fs) {
	const validated = validateToken(token);
	const directory = path.dirname(filePath);
	const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	let handle;

	await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		handle = await fsApi.open(temporaryPath, 'wx', 0o600);
		await handle.writeFile(`${validated}\n`, 'utf8');
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fsApi.chmod(temporaryPath, 0o600);
		await fsApi.rename(temporaryPath, filePath);
	} catch (error) {
		if (handle) await handle.close().catch(() => {});
		await fsApi.unlink(temporaryPath).catch(() => {});
		throw error;
	}
}

export { validateRefreshToken, readToken, writeTokenAtomic };