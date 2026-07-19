import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { AUTH_REQUIRED_EXIT_CODE, createIdler } from '../src/idler.js';

class FakeSteamClient extends EventEmitter {
  constructor() {
    super();
    this.steamID = null;
    this.logOnCalls = [];
    this.personaCalls = [];
    this.gamesCalls = [];
    this.logOffCalls = 0;
  }

  logOn(details) { this.logOnCalls.push(details); }
  setPersona(state) { this.personaCalls.push(state); }
  gamesPlayed(games) { this.gamesCalls.push([...games]); }
  logOff() { this.logOffCalls += 1; }
}

function createHarness(overrides = {}) {
  const client = new FakeSteamClient();
  const logRecords = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map((level) => [
    level,
    (event, fields = {}) => logRecords.push({ level, event, ...fields }),
  ]));
  const retry = {
    pending: false,
    schedules: [],
    resetCalls: 0,
    cancelCalls: 0,
    schedule(callback) {
      if (this.pending) return null;
      this.pending = true;
      this.schedules.push(callback);
      return 30_000;
    },
    reset() { this.pending = false; this.resetCalls += 1; },
    cancel() { this.pending = false; this.cancelCalls += 1; },
  };
  const intervals = [];
  const fatalCodes = [];
  const storedTokens = [];
  const idler = createIdler({
    client,
    games: [10, 20],
    retry,
    logger,
    writeToken: async (token) => { storedTokens.push(token); },
    heartbeatMs: 1_000,
    setIntervalFn: (callback, delay) => {
      const interval = { callback, delay, cleared: false };
      intervals.push(interval);
      return interval;
    },
    clearIntervalFn: (interval) => { interval.cleared = true; },
    onFatal: (code) => { fatalCodes.push(code); },
    eresultNames: {
      5: 'InvalidPassword',
      20: 'ServiceUnavailable',
      88: 'TwoFactorCodeMismatch',
      118: 'MustAgreeToSSA',
      123: 'NoVerifiedPhone',
      126: 'CachedCredentialInvalid',
    },
    personaOnline: 1,
    uptime: () => 123,
    ...overrides,
  });
  return { client, logRecords, retry, intervals, fatalCodes, storedTokens, idler };
}

test('connect logs on with only the refresh token and starts heartbeat', () => {
  const { client, intervals, idler } = createHarness();
  idler.connect('refresh-token-value');
  assert.deepEqual(client.logOnCalls, [{ refreshToken: 'refresh-token-value' }]);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].delay, 1_000);
  assert.equal(idler.state, 'connecting');
});

test('loggedOn starts games and resets retry backoff', () => {
  const { client, retry, idler } = createHarness();
  idler.connect('refresh-token-value');
  client.steamID = { getSteam3RenderedID: () => '[U:1:1]' };
  client.emit('loggedOn');
  assert.deepEqual(client.personaCalls, [1]);
  assert.deepEqual(client.gamesCalls, [[10, 20]]);
  assert.equal(retry.resetCalls, 1);
  assert.equal(idler.state, 'playing');
});

test('nonfatal disconnect uses library auto-relogin without app retry', () => {
  const { client, retry, idler } = createHarness();
  idler.connect('refresh-token-value');
  client.emit('disconnected', 20, 'network unavailable');
  assert.equal(idler.state, 'reconnecting');
  assert.equal(retry.schedules.length, 0);
});

test('blocked playing state is observed and unblocking reasserts games', () => {
  const { client, idler } = createHarness();
  idler.connect('refresh-token-value');
  client.emit('loggedOn');
  client.emit('playingState', true, 440);
  assert.equal(idler.state, 'blocked');
  client.emit('playingState', false, 0);
  assert.equal(idler.state, 'playing');
  assert.deepEqual(client.gamesCalls, [[10, 20], [10, 20]]);
});

test('service-time Steam Guard requires enrollment instead of stdin', () => {
  const { client, fatalCodes, idler } = createHarness();
  idler.connect('refresh-token-value');
  client.emit('steamGuard', null, () => assert.fail('must not submit a code'));
  assert.deepEqual(fatalCodes, [AUTH_REQUIRED_EXIT_CODE]);
  assert.equal(idler.state, 'authentication_required');
});

test('authentication failure notifies once before retaining exit status 78', async () => {
  const notifications = [];
  const { client, fatalCodes, idler } = createHarness({
    notifyAuthenticationRequired: async () => { notifications.push('sent'); },
  });
  idler.connect('refresh-token-value');
  client.emit('steamGuard');
  client.emit('steamGuard');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(notifications, ['sent']);
  assert.deepEqual(fatalCodes, [AUTH_REQUIRED_EXIT_CODE]);
});

test('failed authentication notification is logged without changing exit status', async () => {
  const { client, fatalCodes, logRecords, idler } = createHarness({
    notifyAuthenticationRequired: async () => { throw new Error('Discord unavailable'); },
  });
  idler.connect('refresh-token-value');
  client.emit('steamGuard');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fatalCodes, [AUTH_REQUIRED_EXIT_CODE]);
  assert.ok(logRecords.some((record) => record.event === 'authentication_notification_failed'));
});

for (const eresult of [5, 88]) {
  test(`authentication EResult ${eresult} exits with enrollment status`, () => {
    const { client, fatalCodes, retry, idler } = createHarness();
    idler.connect('refresh-token-value');
    const error = new Error('authentication failed');
    error.eresult = eresult;
    client.emit('error', error);
    assert.deepEqual(fatalCodes, [AUTH_REQUIRED_EXIT_CODE]);
    assert.equal(retry.schedules.length, 0);
  });
}

for (const eresult of [118, 123, 126, 999]) {
  test(`non-transient EResult ${eresult} exits instead of retrying forever`, () => {
    const { client, fatalCodes, retry, idler } = createHarness();
    idler.connect('refresh-token-value');
    const error = new Error('Steam rejected login');
    error.eresult = eresult;
    client.emit('error', error);
    assert.deepEqual(fatalCodes, [AUTH_REQUIRED_EXIT_CODE]);
    assert.equal(retry.schedules.length, 0);
  });
}

for (const [eresult, resultName] of [
  [101, 'AccountLocked'],
  [102, 'AccountLogonDeniedNeedTwoFactorCode'],
  [103, 'AccountLogonDeniedNoMail'],
  [104, 'AccountLogonDeniedNoMailSent'],
  [105, 'AccountLogonDeniedVerifiedEmailRequired'],
  [106, 'CannotUseOldPassword'],
  [107, 'Disabled'],
  [108, 'ExpiredLoginAuthCode'],
  [109, 'IllegalPassword'],
  [110, 'PasswordNotSet'],
  [111, 'RegionLocked'],
  [112, 'RequirePasswordReEntry'],
  [113, 'Banned'],
  [114, 'Suspended'],
  [115, 'IPBanned'],
  [116, 'ParentalControlRestricted'],
  [117, 'AccountDeleted'],
  [118, 'AccountHasBeenDeleted'],
  [119, 'AccountNotFound'],
  [120, 'IPLoginRestrictionFailed'],
  [121, 'InvalidLoginAuthCode'],
  [122, 'PasswordUnset'],
  [123, 'RestrictedDevice'],
  [124, 'AccessDenied'],
]) {
  test(`${resultName} requires operator enrollment`, () => {
    const { client, fatalCodes, retry, idler } = createHarness({
      eresultNames: { [eresult]: resultName },
    });
    idler.connect('refresh-token-value');
    const error = new Error('Steam rejected login');
    error.eresult = eresult;
    client.emit('error', error);
    assert.deepEqual(fatalCodes, [AUTH_REQUIRED_EXIT_CODE]);
    assert.equal(retry.schedules.length, 0);
  });
}

test('transient fatal error schedules only one application retry', () => {
  const { client, retry, idler } = createHarness();
  idler.connect('refresh-token-value');
  const error = new Error('Steam unavailable');
  error.eresult = 20;
  client.emit('error', error);
  client.emit('error', error);
  assert.equal(retry.schedules.length, 1);
  retry.pending = false;
  retry.schedules[0]();
  assert.deepEqual(client.logOnCalls, [
    { refreshToken: 'refresh-token-value' },
    { refreshToken: 'refresh-token-value' },
  ]);
});

for (const resultName of ['LoggedInElsewhere', 'LogonSessionReplaced', 'AlreadyLoggedInElsewhere']) {
  test(`${resultName} is treated as a retryable session replacement`, () => {
    const { client, fatalCodes, retry, idler } = createHarness({
      eresultNames: { 200: resultName },
    });
    idler.connect('refresh-token-value');
    const error = new Error('session replaced');
    error.eresult = 200;
    client.emit('error', error);
    assert.deepEqual(fatalCodes, []);
    assert.equal(retry.schedules.length, 1);
  });
}

test('refreshToken persists the replacement without logging it', async () => {
  const { client, storedTokens, logRecords, idler } = createHarness();
  idler.connect('refresh-token-value');
  client.emit('refreshToken', 'replacement-token');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(storedTokens, ['replacement-token']);
  assert.doesNotMatch(JSON.stringify(logRecords), /replacement-token/);
});

test('refreshToken writes are serialized so the newest token wins', async () => {
  const started = [];
  const resolvers = [];
  const { client, idler } = createHarness({
    writeToken: (token) => new Promise((resolve) => {
      started.push(token);
      resolvers.push(resolve);
    }),
  });
  idler.connect('refresh-token-value');
  client.emit('refreshToken', 'older-token');
  client.emit('refreshToken', 'newer-token');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['older-token']);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ['older-token', 'newer-token']);
  resolvers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
});

test('heartbeat reports local state without tokens', () => {
  const { client, intervals, logRecords, idler } = createHarness();
  idler.connect('refresh-token-value');
  client.steamID = {};
  client.emit('loggedOn');
  intervals[0].callback();
  const heartbeat = logRecords.find((record) => record.event === 'heartbeat');
  assert.deepEqual(heartbeat, {
    level: 'info',
    event: 'heartbeat',
    state: 'playing',
    connected: true,
    blocked: false,
    gameCount: 2,
    uptimeSeconds: 123,
    tokenPersistenceDegraded: false,
    pendingTokenWrites: 0,
  });
});

test('heartbeat reports disconnected while reconnecting', () => {
  const { client, intervals, logRecords, idler } = createHarness();
  idler.connect('refresh-token-value');
  client.steamID = {};
  client.emit('loggedOn');
  client.emit('disconnected', 20, 'network unavailable');
  intervals[0].callback();
  const heartbeat = logRecords.filter((record) => record.event === 'heartbeat').at(-1);
  assert.equal(heartbeat.state, 'reconnecting');
  assert.equal(heartbeat.connected, false);
});

test('failed refresh-token persistence retries until the token is durable', async () => {
  let attempts = 0;
  const delays = [];
  const { client, intervals, logRecords, idler } = createHarness({
    writeToken: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('disk unavailable');
    },
    delayFn: async (delayMs) => { delays.push(delayMs); },
  });
  idler.connect('refresh-token-value');
  client.emit('refreshToken', 'replacement-token');
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1_000, 2_000]);
  intervals[0].callback();
  const heartbeat = logRecords.filter((record) => record.event === 'heartbeat').at(-1);
  assert.equal(heartbeat.tokenPersistenceDegraded, false);
});

test('failed refresh-token persistence stays degraded and the newest token supersedes older work', async () => {
  const attemptedTokens = [];
  let releaseRetry;
  const retryDelay = new Promise((resolve) => { releaseRetry = resolve; });
  const { client, intervals, logRecords, idler } = createHarness({
    writeToken: async (token) => {
      attemptedTokens.push(token);
      if (attemptedTokens.length === 1) throw new Error('disk unavailable');
    },
    delayFn: async () => retryDelay,
  });
  idler.connect('refresh-token-value');
  client.emit('refreshToken', 'older-token');
  await new Promise((resolve) => setImmediate(resolve));
  intervals[0].callback();
  assert.equal(logRecords.filter((record) => record.event === 'heartbeat').at(-1).tokenPersistenceDegraded, true);

  client.emit('refreshToken', 'newest-token');
  releaseRetry();
  await idler.drainTokenWrites();
  assert.deepEqual(attemptedTokens, ['older-token', 'newest-token']);
  intervals[0].callback();
  assert.equal(logRecords.filter((record) => record.event === 'heartbeat').at(-1).tokenPersistenceDegraded, false);
});

test('stop wakes a pending token retry and waits for a bounded durability flush', async () => {
  let attempts = 0;
  const never = new Promise(() => {});
  const { client, idler } = createHarness({
    writeToken: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('disk temporarily unavailable');
    },
    delayFn: async () => never,
  });
  idler.connect('refresh-token-value');
  client.emit('refreshToken', 'replacement-token');
  await new Promise((resolve) => setImmediate(resolve));
  await idler.stop();
  assert.equal(attempts, 2);
});

test('stop cancels timers and logs off once', () => {
  const { client, retry, intervals, idler } = createHarness();
  idler.connect('refresh-token-value');
  idler.stop();
  idler.stop();
  assert.equal(retry.cancelCalls, 1);
  assert.equal(intervals[0].cleared, true);
  assert.equal(client.logOffCalls, 1);
  assert.equal(idler.state, 'stopping');
});

test('stop survives a synchronous logOff failure', () => {
  const { client, logRecords, idler } = createHarness();
  client.logOff = () => { throw new Error('already disconnected'); };
  idler.connect('refresh-token-value');
  assert.doesNotThrow(() => idler.stop());
  assert.ok(logRecords.some((record) => record.event === 'logoff_failed'));
  assert.equal(idler.state, 'stopping');
});

test('Steam events and queued retry callbacks are inert after stop', async () => {
  const { client, retry, storedTokens, fatalCodes, idler } = createHarness();
  idler.connect('refresh-token-value');
  const transient = new Error('Steam unavailable');
  transient.eresult = 20;
  client.emit('error', transient);
  const retryCallback = retry.schedules[0];
  const logOnCount = client.logOnCalls.length;
  idler.stop();

  client.emit('loggedOn');
  client.emit('playingState', true, 440);
  client.emit('steamGuard', null, () => {});
  client.emit('refreshToken', 'post-stop-token');
  client.emit('error', transient);
  retryCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(idler.state, 'stopping');
  assert.equal(client.logOnCalls.length, logOnCount);
  assert.deepEqual(storedTokens, []);
  assert.deepEqual(fatalCodes, []);
});
