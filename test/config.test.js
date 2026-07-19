import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig, parseGames } from '../src/config.js';

test('parseGames accepts one AppID', () => {
  assert.deepEqual(parseGames('440'), [440]);
});

test('parseGames accepts 32 unique positive AppIDs', () => {
  const expected = Array.from({ length: 32 }, (_, index) => index + 1);
  assert.deepEqual(parseGames(expected.join(',')), expected);
});

for (const [name, value] of [
  ['missing', undefined],
  ['empty', ''],
  ['duplicate', '1,1'],
  ['nonnumeric', '1,nope'],
  ['zero', '0'],
  ['negative', '-1'],
  ['too many', Array.from({ length: 33 }, (_, index) => index + 1).join(',')],
]) {
  test(`parseGames rejects ${name} input`, () => {
    assert.throws(() => parseGames(value), /STEAM_GAMES/);
  });
}

test('loadConfig requires absolute state paths and converts heartbeat seconds', () => {
  const config = loadConfig({
    STEAM_GAMES: '10,20',
    STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
    STEAM_DATA_DIR: '/var/lib/steam-idler/data',
    STEAM_HEARTBEAT_SECONDS: '60',
  });

  assert.deepEqual(config, {
    games: [10, 20],
    tokenFile: '/var/lib/steam-idler/refresh-token',
    dataDir: '/var/lib/steam-idler/data',
    heartbeatMs: 60_000,
    discordWebhookUrl: undefined,
  });
});

test('loadConfig defaults heartbeat to five minutes', () => {
  const config = loadConfig({
    STEAM_GAMES: '10',
    STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
    STEAM_DATA_DIR: '/var/lib/steam-idler/data',
  });

  assert.equal(config.heartbeatMs, 300_000);
});

test('loadConfig accepts an optional Discord webhook URL', () => {
  const config = loadConfig({
    STEAM_GAMES: '10',
    STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
    STEAM_DATA_DIR: '/var/lib/steam-idler/data',
    DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token',
  });

  assert.equal(config.discordWebhookUrl, 'https://discord.com/api/webhooks/123/token');
});

for (const [name, value] of [
  ['non-HTTPS URL', 'http://discord.com/api/webhooks/123/token'],
  ['non-Discord URL', 'https://example.com/api/webhooks/123/token'],
  ['non-webhook path', 'https://discord.com/channels/123'],
]) {
  test(`loadConfig rejects ${name} Discord webhook URL`, () => {
    assert.throws(() => loadConfig({
      STEAM_GAMES: '10',
      STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
      STEAM_DATA_DIR: '/var/lib/steam-idler/data',
      DISCORD_WEBHOOK_URL: value,
    }), /DISCORD_WEBHOOK_URL/);
  });
}

for (const [name, overrides] of [
  ['relative token path', { STEAM_TOKEN_FILE: 'refresh-token' }],
  ['relative data path', { STEAM_DATA_DIR: './data' }],
  ['zero heartbeat', { STEAM_HEARTBEAT_SECONDS: '0' }],
  ['fractional heartbeat', { STEAM_HEARTBEAT_SECONDS: '1.5' }],
]) {
  test(`loadConfig rejects ${name}`, () => {
    assert.throws(() => loadConfig({
      STEAM_GAMES: '10',
      STEAM_TOKEN_FILE: '/var/lib/steam-idler/refresh-token',
      STEAM_DATA_DIR: '/var/lib/steam-idler/data',
      ...overrides,
    }));
  });
}
