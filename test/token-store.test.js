import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as fs from 'node:fs/promises';
import { readToken, validateRefreshToken, writeTokenAtomic } from '../src/token-store.js';

async function tempTokenPath() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'steam-idler-token-'));
  return path.join(directory, 'refresh-token');
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'EdDSA', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('refresh-token validation accepts only unexpired SteamClient refresh JWTs', () => {
  const valid = {
    iss: 'steam',
    sub: '76561198000000000',
    aud: ['web', 'client', 'derive'],
    iat: 1_700_000_000,
    exp: 2_000_000_000,
  };
  assert.doesNotThrow(() => validateRefreshToken(jwt(valid), () => 1_800_000_000_000));

  for (const token of [
    'not-a-jwt',
    jwt({ ...valid, iss: 'other' }),
    jwt({ ...valid, sub: 'not-a-steamid' }),
    jwt({ ...valid, aud: ['web', 'derive'] }),
    jwt({ ...valid, aud: ['web', 'client'] }),
    jwt({ ...valid, exp: 1_700_000_000 }),
  ]) {
    assert.throws(() => validateRefreshToken(token, () => 1_800_000_000_000), /refresh token/i);
  }
});

test('token store writes, protects, reads, and replaces a token', async () => {
  const filePath = await tempTokenPath();
  const chmodModes = [];
  const trackingFs = {
    ...fs,
    chmod: async (target, mode) => {
      chmodModes.push({ target, mode });
      await fs.chmod(target, mode);
    },
  };
  await writeTokenAtomic(filePath, 'first-token', trackingFs);
  assert.equal(await readToken(filePath), 'first-token');
  assert.equal(chmodModes.at(-1).mode, 0o600);
  if (process.platform !== 'win32') {
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  }

  await writeTokenAtomic(filePath, 'second-token');
  assert.equal(await readToken(filePath), 'second-token');
  assert.equal(await readFile(filePath, 'utf8'), 'second-token\n');
});

for (const value of ['', '   ', 'line-one\nline-two']) {
  test(`token store rejects invalid token ${JSON.stringify(value)}`, async () => {
    const filePath = await tempTokenPath();
    await assert.rejects(writeTokenAtomic(filePath, value), /refresh token/i);
  });
}

test('failed atomic rename preserves the previous token', async () => {
  const filePath = await tempTokenPath();
  await writeTokenAtomic(filePath, 'previous-token');
  const failingFs = {
    ...fs,
    rename: async () => { throw new Error('rename failed'); },
  };

  await assert.rejects(writeTokenAtomic(filePath, 'new-token', failingFs), /rename failed/);
  assert.equal(await readToken(filePath), 'previous-token');
});
