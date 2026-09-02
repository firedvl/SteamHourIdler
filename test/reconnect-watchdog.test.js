import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createIdler } from '../src/idler.js';

class FakeSteamClient extends EventEmitter {
	logOn() {}
	setPersona() {}
	gamesPlayed() {}
	logOff() {}
}

function createHarness() {
	const client = new FakeSteamClient();
	const fatalCodes = [];
	const logRecords = [];
	const timers = [];
	const retry = {
		reset() {},
		cancel() {},
		schedule() { return 30_000; },
	};
	const idler = createIdler({
		client,
		games: [10],
		retry,
		logger: Object.fromEntries(['info', 'warn', 'error'].map((level) => [
			level,
			(event, fields = {}) => logRecords.push({ level, event, ...fields }),
		])),
		writeToken: async () => {},
		heartbeatMs: 300_000,
		setIntervalFn: () => ({ unref() {} }),
		clearIntervalFn: () => {},
		setReconnectTimeoutFn: (callback, delay) => {
			const timer = { callback, delay, cleared: false, unref() {} };
			timers.push(timer);
			return timer;
		},
		clearReconnectTimeoutFn: (timer) => { timer.cleared = true; },
		onFatal: (code) => fatalCodes.push(code),
		personaOnline: 1,
	});
	return { client, fatalCodes, logRecords, timers, idler };
}

test('stalled library auto-relogin triggers a supervised restart after ten minutes', () => {
	const { client, fatalCodes, logRecords, timers, idler } = createHarness();
	idler.connect('refresh-token');
	client.emit('disconnected', 0, 'connection closed');

	assert.equal(idler.state, 'reconnecting');
	assert.equal(timers.length, 1);
	assert.equal(timers[0].delay, 10 * 60 * 1_000);

	timers[0].callback();
	assert.deepEqual(fatalCodes, [1]);
	assert.ok(logRecords.some((record) => record.event === 'reconnect_watchdog_expired'));
});

test('successful auto-relogin cancels the reconnect watchdog', () => {
	const { client, fatalCodes, timers, idler } = createHarness();
	idler.connect('refresh-token');
	client.emit('disconnected', 0, 'connection closed');
	client.emit('loggedOn');

	assert.equal(timers[0].cleared, true);
	assert.equal(idler.state, 'playing');
	timers[0].callback();
	assert.deepEqual(fatalCodes, []);
});
