import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const unitUrl = new URL('../deploy/steam-idler.service', import.meta.url);

test('systemd unit preserves restart, operator-exit, and shutdown policies', async () => {
  const unit = await readFile(unitUrl, 'utf8');

  assert.match(unit, /^User=steam-idler$/m);
  assert.match(unit, /^ExecStart=\/usr\/bin\/node \/opt\/steam-idler\/src\/main\.js$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartSec=30$/m);
  assert.match(unit, /^RestartPreventExitStatus=78$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.doesNotMatch(unit, /^StartLimitBurst=/m);
  assert.match(unit, /^UMask=0077$/m);

  const timeoutSeconds = Number(unit.match(/^TimeoutStopSec=(\d+)$/m)?.[1]);
  assert.ok(timeoutSeconds > 30, 'systemd must outlive the 30-second token shutdown flush');
});
