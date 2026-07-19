import assert from 'node:assert/strict';
import test from 'node:test';

import { createLogger, redact } from '../src/logger.js';

test('redact removes nested secrets without mutating the input', () => {
  const input = {
    event: 'failure',
    password: 'bad',
    nested: {
      refreshToken: 'token-value',
      cookie: 'session=value',
      safe: 42,
    },
    values: [{ authorization: 'Bearer abc' }],
  };

  assert.deepEqual(redact(input), {
    event: 'failure',
    password: '[REDACTED]',
    nested: {
      refreshToken: '[REDACTED]',
      cookie: '[REDACTED]',
      safe: 42,
    },
    values: [{ authorization: '[REDACTED]' }],
  });
  assert.equal(input.password, 'bad');
});

test('redact removes JWT-like values from otherwise safe strings', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature';
  assert.equal(redact(`failed for ${jwt}`), 'failed for [REDACTED]');
});

test('logger emits one timestamped JSON line to the correct stream', () => {
  let stdout = '';
  let stderr = '';
  const logger = createLogger({
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    now: () => new Date('2026-07-19T12:00:00.000Z'),
  });

  logger.info('connected', { state: 'playing', refreshToken: 'secret' });
  logger.error('failed', { message: 'network unavailable' });

  const info = JSON.parse(stdout.trim());
  const error = JSON.parse(stderr.trim());
  assert.deepEqual(info, {
    timestamp: '2026-07-19T12:00:00.000Z',
    level: 'info',
    event: 'connected',
    state: 'playing',
    refreshToken: '[REDACTED]',
  });
  assert.equal(error.level, 'error');
  assert.equal(error.event, 'failed');
});
