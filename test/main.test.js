import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { OperatorActionRequiredError } from '../src/errors.js';
import { runMain, runService } from '../src/main.js';

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    this.exitCode = undefined;
  }
  uptime() { return 10; }
}

test('runService composes a token-only Steam client and handles shutdown', async () => {
  const processRef = new FakeProcess();
  const records = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [
    level,
    (event, fields = {}) => records.push({ level, event, ...fields }),
  ]));
  let clientOptions;
  class FakeSteamUser {
    static EPersonaState = { Online: 1 };
    static EResult = { 20: 'ServiceUnavailable' };
    constructor(options) { clientOptions = options; }
  }
  let idlerDependencies;
  const notifierCalls = [];
  const calls = { connect: [], stop: 0 };
  const fakeIdler = {
    connect: (token) => calls.connect.push(token),
    stop: () => { calls.stop += 1; },
  };

  await runService({
    env: {
      STEAM_GAMES: '10,20',
      STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
      STEAM_DATA_DIR: '/var/lib/steam-idler/data',
      STEAM_HEARTBEAT_SECONDS: '60',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token',
    },
    SteamUserClass: FakeSteamUser,
    logger,
    processRef,
    readTokenFn: async () => 'refresh-token-value',
    validateTokenFn: () => {},
    writeTokenFn: async () => {},
    createNotifierFn: ({ webhookUrl }) => {
      notifierCalls.push(webhookUrl);
      return async () => {};
    },
    createIdlerFn: (dependencies) => {
      idlerDependencies = dependencies;
      return fakeIdler;
    },
  });

  assert.deepEqual(clientOptions, {
    autoRelogin: true,
    dataDirectory: '/var/lib/steam-idler/data',
    promptSteamGuardCode: false,
    renewRefreshTokens: true,
  });
  assert.deepEqual(calls.connect, ['refresh-token-value']);
  assert.deepEqual(idlerDependencies.games, [10, 20]);
  assert.equal(idlerDependencies.personaOnline, 1);
  assert.deepEqual(notifierCalls, ['https://discord.com/api/webhooks/123/token']);
  assert.equal(typeof idlerDependencies.notifyAuthenticationRequired, 'function');

  processRef.emit('SIGTERM');
  processRef.emit('SIGTERM');
  assert.equal(calls.stop, 1);
  assert.equal(processRef.exitCode, 0);

  idlerDependencies.onFatal(78);
  assert.equal(processRef.exitCode, 78);
  assert.ok(records.some((record) => record.event === 'shutdown_requested'));
});

test('unhandled rejection is logged and causes a nonzero shutdown', async () => {
  const processRef = new FakeProcess();
  const records = [];
  const logger = {
    info() {},
    warn() {},
    error: (event, fields = {}) => records.push({ event, ...fields }),
  };
  class FakeSteamUser {
    static EPersonaState = { Online: 1 };
    static EResult = {};
  }
  let stopCalls = 0;

  await runService({
    env: {
      STEAM_GAMES: '10',
      STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
      STEAM_DATA_DIR: '/var/lib/steam-idler/data',
    },
    SteamUserClass: FakeSteamUser,
    logger,
    processRef,
    readTokenFn: async () => 'refresh-token-value',
    validateTokenFn: () => {},
    writeTokenFn: async () => {},
    createIdlerFn: () => ({ connect() {}, stop() { stopCalls += 1; } }),
  });

  processRef.emit('unhandledRejection', new Error('async failure'));
  assert.equal(processRef.exitCode, 1);
  assert.equal(stopCalls, 1);
  assert.equal(records[0].event, 'unhandled_rejection');
});

test('runMain maps operator action to 78 and unexpected startup failure to 1', async () => {
  for (const [error, expectedCode] of [
    [new OperatorActionRequiredError('enroll first'), 78],
    [new Error('constructor failed'), 1],
  ]) {
    const processRef = { exitCode: undefined };
    const records = [];
    await runMain({
      logger: { error: (event, fields) => records.push({ event, ...fields }) },
      processRef,
      runServiceFn: async () => { throw error; },
    });
    assert.equal(processRef.exitCode, expectedCode);
    assert.equal(records[0].event, 'startup_failed');
  }
});

test('missing token file becomes an operator-action startup error', async () => {
  class FakeSteamUser {}
  const missing = new Error('missing');
  missing.code = 'ENOENT';
  await assert.rejects(runService({
    env: {
      STEAM_GAMES: '10',
      STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
      STEAM_DATA_DIR: '/var/lib/steam-idler/data',
    },
    SteamUserClass: FakeSteamUser,
    logger: { info() {}, warn() {}, error() {} },
    readTokenFn: async () => { throw missing; },
  }), OperatorActionRequiredError);
});

test('malformed refresh token becomes an operator-action startup error', async () => {
  class FakeSteamUser {}
  await assert.rejects(runService({
    env: {
      STEAM_GAMES: '10',
      STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
      STEAM_DATA_DIR: '/var/lib/steam-idler/data',
    },
    SteamUserClass: FakeSteamUser,
    logger: { info() {}, warn() {}, error() {} },
    readTokenFn: async () => 'truncated-token',
  }), OperatorActionRequiredError);
});
