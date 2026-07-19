# Discord Authentication-Renewal Notification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send an optional Discord webhook message when Steam Idler requires re-enrollment.

**Architecture:** A new notifier module owns Discord URL validation and safe, fire-and-forget delivery. `loadConfig` exposes an optional webhook URL, `runService` constructs the notifier, and `createIdler` invokes it once when it enters `authentication_required`; failed delivery is logged and cannot affect the existing status-78 shutdown.

**Tech Stack:** Node.js 24 built-in `fetch`, `node:test`, `node:assert/strict`.

## Global Constraints

- The feature is disabled when `DISCORD_WEBHOOK_URL` is absent or empty.
- Only HTTPS URLs for `discord.com/api/webhooks/<id>/<token>` are accepted.
- The Discord message is fixed and contains no Steam account, refresh token, webhook URL, Steam error, or Steam error code.
- Delivery failure logs `authentication_notification_failed` without changing authentication-required logging or exit status 78.
- Do not add dependencies, retries, SMS support, arbitrary webhook support, or alerts for non-authentication failures.

---

### Task 1: Configuration and Discord notifier

**Files:**
- Create: `src/notifier.js`
- Modify: `src/config.js`
- Test: `test/notifier.test.js`
- Test: `test/config.test.js`

**Interfaces:**
- Produces: `parseDiscordWebhookUrl(value)` returning `undefined` for absent or blank values and a normalized URL string for valid input.
- Produces: `createAuthenticationNotifier({ webhookUrl, fetchFn })` returning `undefined` when disabled, otherwise an async function that sends the fixed message.
- Produces: `config.discordWebhookUrl`, passed to service composition by Task 2.

- [ ] **Step 1: Write failing configuration and notifier tests**

```js
test('loadConfig accepts an optional Discord webhook URL', () => {
  const config = loadConfig({
    STEAM_GAMES: '10',
    STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
    STEAM_DATA_DIR: '/var/lib/steam-idler/data',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token',
  });
  assert.equal(config.discordWebhookUrl, 'https://discord.com/api/webhooks/123/token');
});

test('authentication notifier posts the fixed renewal message', async () => {
  const calls = [];
  const notify = createAuthenticationNotifier({
    webhookUrl: 'https://discord.com/api/webhooks/123/token',
    fetchFn: async (...args) => { calls.push(args); return { ok: true }; },
  });
  await notify();
  assert.deepEqual(calls, [[
    'https://discord.com/api/webhooks/123/token',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Steam Idler needs authentication renewal. Run the enrollment command, then start the service.' }) },
  ]]);
});
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test test/config.test.js test/notifier.test.js`

Expected: FAIL because `discordWebhookUrl` and `src/notifier.js` do not exist.

- [ ] **Step 3: Implement the smallest configuration and notifier API**

```js
const DISCORD_WEBHOOK_CONTENT = 'Steam Idler needs authentication renewal. Run the enrollment command, then start the service.';

function createAuthenticationNotifier({ webhookUrl, fetchFn = fetch } = {}) {
  if (webhookUrl === undefined) return undefined;
  return async function notifyAuthenticationRequired() {
    const response = await fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: DISCORD_WEBHOOK_CONTENT }),
    });
    if (!response.ok) throw new Error(`Discord webhook request failed with status ${response.status}`);
  };
}
```

Add `parseDiscordWebhookUrl` to `src/config.js`, and add `discordWebhookUrl` to the returned config object. Reject malformed, non-HTTPS, non-`discord.com`, or non-webhook-path values through `OperatorActionRequiredError` without echoing the configured URL.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `node --test test/config.test.js test/notifier.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/config.js src/notifier.js test/config.test.js test/notifier.test.js
git commit -m "feat: add Discord authentication notifier"
```

### Task 2: Authentication-state integration

**Files:**
- Modify: `src/main.js`
- Modify: `src/idler.js`
- Test: `test/main.test.js`
- Test: `test/idler.test.js`

**Interfaces:**
- Consumes: `createAuthenticationNotifier({ webhookUrl })` from Task 1.
- Consumes: optional `notifyAuthenticationRequired` function in `createIdler`.
- Produces: one notification attempt for each service run that first reaches `authentication_required`.

- [ ] **Step 1: Write failing integration tests**

```js
test('authentication failure notifies once before retaining exit status 78', async () => {
  const calls = [];
  const { client, fatalCodes, idler } = createHarness({
    notifyAuthenticationRequired: async () => { calls.push('notified'); },
  });
  idler.connect('refresh-token-value');
  client.emit('steamGuard');
  client.emit('steamGuard');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['notified']);
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
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `node --test test/idler.test.js test/main.test.js`

Expected: FAIL because the notifier dependency is not yet used.

- [ ] **Step 3: Implement fire-and-forget delivery**

```js
function requireEnrollment(reason, fields = {}) {
  if (state === 'authentication_required') return;
  setState('authentication_required');
  connected = false;
  retry.cancel();
  logger.error('authentication_required', { reason, ...fields });
  if (notifyAuthenticationRequired !== undefined) {
    void notifyAuthenticationRequired().catch((error) => {
      logger.warn('authentication_notification_failed', { error });
    });
  }
  onFatal(AUTH_REQUIRED_EXIT_CODE);
}
```

In `runService`, build the notifier from `config.discordWebhookUrl` and inject it into `createIdler`. Do not await the notifier or alter `shutdown`.

- [ ] **Step 4: Run the targeted tests to verify they pass**

Run: `node --test test/idler.test.js test/main.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/main.js src/idler.js test/main.test.js test/idler.test.js
git commit -m "feat: notify Discord when enrollment is required"
```

### Task 3: Operator configuration and final verification

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DISCORD_WEBHOOK_URL` configuration from Task 1.
- Produces: documented opt-in setup and syntax coverage for `src/notifier.js`.

- [ ] **Step 1: Update the environment example and operations documentation**

```dotenv
# Optional. Keep this URL secret; omit to disable Discord notifications.
DISCORD_WEBHOOK_URL=
```

Document that a configured Discord webhook receives one fixed notification only when re-enrollment is required; delivery errors are logged and do not prevent the status-78 exit. Include the warning not to commit the URL.

- [ ] **Step 2: Extend the syntax-check script**

```json
"check": "node --check src/config.js && node --check src/errors.js && node --check src/logger.js && node --check src/notifier.js && node --check src/retry.js && node --check src/token-store.js && node --check src/idler.js && node --check src/main.js && node --check scripts/enroll.js"
```

- [ ] **Step 3: Run final verification**

Run: `npm test; npm run check; git diff --check`

Expected: all tests pass, each listed JavaScript file parses, and no whitespace errors are reported.

- [ ] **Step 4: Commit Task 3**

```bash
git add .env.example README.md package.json
git commit -m "docs: explain Discord renewal notifications"
```
