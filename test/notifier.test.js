import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuthenticationNotifier } from '../src/notifier.js';

test('authentication notifier is disabled without a webhook URL', () => {
  assert.equal(createAuthenticationNotifier(), undefined);
});

test('authentication notifier posts the fixed renewal message', async () => {
  const calls = [];
  const notify = createAuthenticationNotifier({
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    fetchFn: async (...args) => {
      calls.push(args);
      return { ok: true };
    },
  });

  await notify();

  assert.deepEqual(calls, [[
    'https://discord.com/api/webhooks/123/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'Steam Idler needs authentication renewal. Run the enrollment command, then start the service.',
      }),
    },
  ]]);
});

test('authentication notifier rejects an unsuccessful Discord response', async () => {
  const notify = createAuthenticationNotifier({
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    fetchFn: async () => ({ ok: false, status: 500 }),
  });

  await assert.rejects(notify(), /Discord webhook request failed/);
});
