# Steam Idler

A program that runs games on a Steam account to increase the amount of hours played automatically. This program is mean to be run on a Ubuntu server and after a full configuration, will run automatically when the system starts, or when the program is not running.

## Features

- Unattended refresh-token login after one-time mobile approval
- Automatic reconnects and systemd crash recovery
- Atomic refresh-token renewal with durable retry
- Optional Discord alert when enrollment is required
- Redacted JSON logs and periodic health heartbeats
- Strict validation for 1 through 32 unique AppIDs
- Deterministic tests that never contact Steam

## Local development

```bash
npm ci --ignore-scripts
npm test
npm run check
npm audit --omit=dev
```

Tests use fake Steam clients and do not contact Steam.

Copy `.env.example` to an ignored local file when testing configuration. Replace the sample AppIDs with your own; never commit account-specific configuration or credentials.

## Install on Ubuntu

Run these commands from the project directory:

```bash
sudo useradd --system --user-group --home-dir /var/lib/steam-idler \
	--create-home --shell /usr/sbin/nologin steam-idler

sudo install -d -o root -g root -m 0755 /opt/steam-idler
sudo install -d -o steam-idler -g steam-idler -m 0700 /var/lib/steam-idler/data

sudo cp -a package.json package-lock.json src scripts /opt/steam-idler/
sudo chown -R root:root /opt/steam-idler
sudo npm --prefix /opt/steam-idler ci --omit=dev --ignore-scripts

sudo install -o root -g steam-idler -m 0640 .env.example /etc/steam-idler.env
sudo install -o root -g root -m 0644 deploy/steam-idler.service \
	/etc/systemd/system/steam-idler.service
```

If the `steam-idler` user already exists, `useradd` will report that and the remaining commands can continue.

Review `/etc/steam-idler.env`. `STEAM_GAMES` must contain 1 through 32 unique positive AppIDs. Keep these fixed paths:

```dotenv
STEAM_TOKEN_FILE=/var/lib/steam-idler/refresh-token
STEAM_DATA_DIR=/var/lib/steam-idler/data
```

To receive an optional Discord alert when the service needs a new enrollment, add an incoming webhook URL. Treat it as a secret and never commit it:

```dotenv
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook-id/your-webhook-token
```

Omit `DISCORD_WEBHOOK_URL` to disable notifications.

## Enroll the Steam account

Enrollment sends the account name and password directly to Steam for one login session. The password is hidden and is not written to disk. Approve the prompt in the Steam mobile app when requested.

```bash
sudo -u steam-idler -H /bin/bash -c '
  set -a
  source /etc/steam-idler.env
  set +a
  cd /opt/steam-idler
  /usr/bin/npm run enroll
'
```

Confirm the token file is owned by the service account and is not group/world-readable:

```bash
sudo stat -c '%U:%G %a %n' /var/lib/steam-idler/refresh-token
```

Expected mode: `steam-idler:steam-idler 600`.

## Enable and start

```bash
sudo systemd-analyze verify /etc/systemd/system/steam-idler.service
sudo systemctl daemon-reload
sudo systemctl enable --now steam-idler
sudo systemctl status steam-idler --no-pager
```

Follow logs:

```bash
sudo journalctl -u steam-idler -f
```

A healthy service emits `logged_on`, `playing_confirmed`, and periodic `heartbeat` JSON records. A heartbeat reports only the locally observed client state; it does not prove that Steam has credited playtime.

## Operations

```bash
sudo systemctl restart steam-idler
sudo systemctl stop steam-idler
sudo systemctl start steam-idler
sudo journalctl -u steam-idler --since '24 hours ago'
```

To prove automatic restart, terminate the service process without stopping the unit:

```bash
old_pid="$(systemctl show -p MainPID --value steam-idler)"
sudo kill -TERM "$old_pid"
sleep 12
systemctl show -p MainPID --value steam-idler
```

The second PID must be nonzero and different from the first.

## Authentication renewal

Refresh tokens normally remain valid for months. If the service exits with status 78 or logs `authentication_required`, rerun the enrollment command and then start the service:

```bash
sudo systemctl stop steam-idler
sudo -u steam-idler -H /bin/bash -c '
	set -a
	source /etc/steam-idler.env
	set +a
	cd /opt/steam-idler
	/usr/bin/npm run enroll
'
sudo systemctl start steam-idler
```

The service also saves refresh-token renewals atomically while running.

If `DISCORD_WEBHOOK_URL` is configured, the service sends one fixed notification when it requires enrollment. A Discord delivery failure is logged as `authentication_notification_failed` and does not prevent the status-78 exit.

## Troubleshooting unexpected exits

Inspect service history and kernel memory-pressure events:

```bash
sudo journalctl -u steam-idler --since '7 days ago'
sudo journalctl -k --since '7 days ago' | grep -Ei 'out of memory|oom|killed process'
```

Important events:

- `authentication_required`: rerun enrollment. Status 78 is intentionally not restarted.
- `retry_scheduled`: a fatal but retryable Steam error occurred; the delay is logged.
- `disconnected`: `steam-user` is handling a nonfatal reconnect.
- `playing_blocked`: another Steam session is using the account. This service will not kick it.
- `refresh_token_save_retry`: a renewed token is not yet durable. The service keeps retrying with capped backoff and always retains the newest token; repair storage permissions and wait for `refresh_token_saved` before restarting.
- `refresh_token_shutdown_flush_expired`: shutdown could not make the newest token durable within 30 seconds. Repair storage and rerun enrollment before starting the service.
- `uncaught_exception` or `unhandled_rejection`: the process failed; `systemd` restarts it and retains the diagnostic record.

## Updating

Use this procedure after pulling or otherwise applying changes in the project directory. It replaces only the deployed program files; it does not replace the refresh token or service configuration.

```bash
sudo systemctl stop steam-idler

# Copy application code and reinstall the exact production dependencies.
sudo cp -a package.json package-lock.json src scripts /opt/steam-idler/
sudo chown -R root:root /opt/steam-idler
sudo npm --prefix /opt/steam-idler ci --omit=dev --ignore-scripts
```

If `deploy/steam-idler.service` changed, install the revised unit and reload systemd:

```bash
sudo install -o root -g root -m 0644 deploy/steam-idler.service \
  /etc/systemd/system/steam-idler.service
sudo systemctl daemon-reload
```

If `.env.example` changed, compare it with `/etc/steam-idler.env` and add any required settings manually. Do not copy `.env.example` over the live file: it can replace your game list or Discord webhook configuration.

Do not replace `/var/lib/steam-idler`; it contains the refresh token and Steam client data. Start and verify the updated service:

```bash
sudo systemd-analyze verify /etc/systemd/system/steam-idler.service
sudo systemctl start steam-idler
sudo systemctl status steam-idler --no-pager
```

Then inspect the first logs for a successful login:

```bash
sudo journalctl -u steam-idler -n 50 --no-pager
```