# Discord authentication-renewal notification

## Purpose

Optionally alert an operator through Discord when Steam Idler cannot continue without a new enrollment. The feature helps an operator act promptly while preserving the service's current authentication failure behavior.

## Scope

The service will support a single optional Discord incoming-webhook URL through `DISCORD_WEBHOOK_URL`. The feature is disabled when that variable is absent or empty. It does not support SMS, arbitrary webhooks, notification retries, or alerts for non-authentication failures.

## Configuration

`loadConfig` will read `DISCORD_WEBHOOK_URL` and either return `undefined` or a validated HTTPS Discord webhook URL. Invalid configured values will make startup fail as an operator-action error, matching the existing configuration validation model.

The URL is secret configuration. It must not appear in logs, exceptions, health data, or Discord message content.

## Delivery and failure behavior

A dedicated notifier module will send a fixed Discord message when the idler first reaches `authentication_required`:

> Steam Idler needs authentication renewal. Run the enrollment command, then start the service.

The idler already guards this state transition, so at most one notification is attempted for a service run. The notification does not contain an account name, refresh token, webhook URL, raw Steam error, or Steam error code.

Delivery uses the built-in `fetch` API. A rejected request or non-success HTTP response is logged as `authentication_notification_failed` without sensitive details. Notification failure does not delay, cancel, or alter the existing status-78 shutdown path.

## Integration

`runService` will create the optional notifier from configuration and pass it to `createIdler`. When enrollment is required, `createIdler` will start the notification attempt before it invokes its fatal callback. The fatal callback keeps its current immediate shutdown behavior; the process does not wait for Discord delivery.

## Tests and documentation

Tests will cover URL validation, disabled configuration, Discord request construction, non-success and rejected delivery, and the fact that authentication failure still exits with status 78 while notifying only once. README and `.env.example` will document opt-in configuration, secret handling, and the no-retry behavior.

## Success criteria

- No Discord request is made unless `DISCORD_WEBHOOK_URL` is configured.
- A valid configuration sends exactly one redacted, fixed message for an authentication-renewal requirement.
- Discord delivery errors leave the existing authentication-required log and exit-status behavior intact.
- Unit tests, syntax checks, and documentation remain consistent with the implementation.
