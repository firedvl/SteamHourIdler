import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { runEnrollment } from '../scripts/enroll.js';

const guardTypes = {
  DeviceCode: 2,
  DeviceConfirmation: 3,
};

class FakeLoginSession extends EventEmitter {
  static result = { actionRequired: true, validActions: [{ type: guardTypes.DeviceConfirmation }] };
  static instance;

  constructor(platformType, options) {
    super();
    this.platformType = platformType;
    this.options = options;
    this.startCalls = [];
    this.codeCalls = [];
    FakeLoginSession.instance = this;
  }

  async startWithCredentials(details) {
    this.startCalls.push(details);
    queueMicrotask(() => {
      this.refreshToken = 'issued-refresh-token';
      this.emit('authenticated');
    });
    return FakeLoginSession.result;
  }

  async submitSteamGuardCode(code) {
    this.codeCalls.push(code);
  }
}

function createHarness(overrides = {}) {
  const records = [];
  const written = [];
  return {
    records,
    written,
    dependencies: {
      LoginSessionClass: FakeLoginSession,
      platformType: 1,
      persistence: 9,
      guardTypes,
      accountName: 'account-name',
      password: 'password-value',
      tokenFile: '/var/lib/steam-idler/refresh-token',
      readGuardCode: () => 'guard-code',
      writeToken: async (filePath, token) => { written.push({ filePath, token }); },
      logger: {
        info: (event, fields = {}) => records.push({ level: 'info', event, ...fields }),
        error: (event, fields = {}) => records.push({ level: 'error', event, ...fields }),
      },
      ...overrides,
    },
  };
}

test('enrollment waits for mobile approval and stores the refresh token', async () => {
  FakeLoginSession.result = {
    actionRequired: true,
    validActions: [{ type: guardTypes.DeviceConfirmation }],
  };
  const { dependencies, records, written } = createHarness();

  await runEnrollment(dependencies);

  assert.deepEqual(FakeLoginSession.instance.startCalls, [{
    accountName: 'account-name',
    password: 'password-value',
    persistence: 9,
  }]);
  assert.equal(FakeLoginSession.instance.options.machineId, true);
  assert.deepEqual(written, [{
    filePath: '/var/lib/steam-idler/refresh-token',
    token: 'issued-refresh-token',
  }]);
  assert.ok(records.some((record) => record.event === 'mobile_approval_required'));
  assert.doesNotMatch(JSON.stringify(records), /password-value|issued-refresh-token|account-name/);
  assert.equal(FakeLoginSession.instance.listenerCount('authenticated'), 0);
  assert.equal(FakeLoginSession.instance.listenerCount('timeout'), 0);
  assert.equal(FakeLoginSession.instance.listenerCount('error'), 0);
});

test('enrollment accepts a device code when mobile approval is unavailable', async () => {
  FakeLoginSession.result = {
    actionRequired: true,
    validActions: [{ type: guardTypes.DeviceCode }],
  };
  const { dependencies } = createHarness();

  await runEnrollment(dependencies);

  assert.deepEqual(FakeLoginSession.instance.codeCalls, ['guard-code']);
});

test('enrollment rejects unsupported guard actions', async () => {
  FakeLoginSession.result = {
    actionRequired: true,
    validActions: [{ type: 999 }],
  };
  const { dependencies } = createHarness();

  await assert.rejects(runEnrollment(dependencies), /supported Steam Guard action/);
});

test('enrollment propagates session timeout', async () => {
  class TimeoutSession extends FakeLoginSession {
    async startWithCredentials(details) {
      this.startCalls.push(details);
      queueMicrotask(() => this.emit('timeout'));
      return {
        actionRequired: true,
        validActions: [{ type: guardTypes.DeviceConfirmation }],
      };
    }
  }
  const { dependencies } = createHarness({ LoginSessionClass: TimeoutSession });

  await assert.rejects(runEnrollment(dependencies), /timed out/);
});

test('session error before startWithCredentials rejection is handled', async () => {
  class RacingSession extends FakeLoginSession {
    async startWithCredentials(details) {
      this.startCalls.push(details);
      queueMicrotask(() => this.emit('error', new Error('session error')));
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error('start failed');
    }
  }
  const { dependencies } = createHarness({ LoginSessionClass: RacingSession });

  await assert.rejects(runEnrollment(dependencies), /start failed/);
});
