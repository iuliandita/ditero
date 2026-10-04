<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/ditero-wordmark-dark.png">
    <img src="assets/brand/ditero-wordmark-light.png" alt="Ditero" width="420">
  </picture>
</p>

<p align="center"><strong>Shared tasks for the people you share life with.</strong></p>

<p align="center">
  <a href="https://github.com/iuliandita/ditero/actions/workflows/ci.yml"><img src="https://github.com/iuliandita/ditero/actions/workflows/ci.yml/badge.svg?branch=develop" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/status-alpha-orange" alt="Status: alpha">
</p>

Ditero is a free, self-hosted, local-first task app for families, friends, clubs,
and small teams. Share a shopping list, divide the chores, plan a project, or keep
up with daily habits. Work offline and sync when you're connected again.

Your data lives on your server. Reminders, attachments, calendars, and sharing
are included, with no subscriptions or paid feature unlocks.

[Quick start](#run-it-docker-compose) | [Features](#available-on-develop) | [Documentation](#documentation) | [Roadmap](docs/ROADMAP.md) | [Brand assets](assets/brand/README.md)

> **Alpha.** The first release is `v0.0.1-alpha.1`. Its pipeline packages server
> containers, Helm/Compose deployment files, desktop installers and signed Android
> downloads. Native platform qualification remains in progress; Windows builds are
> unsigned and macOS builds use ad-hoc signatures. Breaking changes are expected
> before `v1.0.0`. See [release instructions](RELEASING.md) and
> [published downloads](https://github.com/iuliandita/ditero/releases).

The capabilities below describe `develop`; unreleased additions are available
from source or nightly images.

## Made for shared days

Keep personal lists alongside shared workspaces. Assign tasks, leave comments,
and invite people with the access they need. Shopping lists, recurring chores,
and habit streaks cover the everyday work that falls between a calendar and a chat.

The interface supports six languages, including Arabic and RTL layout. Choose
light, dark, or system mode, then choose an accent: teal by default, or blue,
clay, violet, berry, or ochre. Reading-size presets and high contrast are independent
of those choices. Palettes and accent preferences sync with your account; reading
size and high contrast stay on each device.

## Available on develop

- Unified typed lists: tasks, shopping lists, checklists, and projects
- Subtasks, labels, priorities, due dates, folders, and drag-to-reorder
- Recurring tasks and habits/chores with flexible recurrence (RFC 5545 RRULE) and streaks
- Reminders with escalation and acknowledgement, delivered to ntfy, Telegram, Discord,
  Slack, or email
- Multi-workspace sharing with Owner / Admin / Member / Viewer roles
- Invitation links, managed accounts, comments, and recorded task completion history
- Email/password, passkeys, TOTP, recovery codes, and optional Google sign-in
- English, German, Spanish, French, Romanian, and Arabic, including RTL layout
- Light, dark, and system modes, six accent themes, reading-size presets, and high contrast
- Named light/dark palettes, runtime color editing and validated JSON sharing;
  [custom palettes](docs/themes.md) sync with your account
- Saved views, dashboards, calendar/board/table layouts, keyboard shortcuts, and a focus timer
- Encrypted attachments with filesystem or S3-compatible server storage
- JSON export and reviewed, resumable native import, including version 2 history
  and attribution; see
  [data portability](docs/runbooks/data-portability.md) for exclusions
- Browser installation plus Android and desktop development apps; see
  [native app status](#browser-installation-and-native-development-apps)
- Membership-scoped public API with expiring personal access tokens, OpenAPI,
  and idempotent task creation, completion, updates and deletion; see
  [API access](docs/runbooks/public-api.md)
- [CLI](docs/cli.md) and [local MCP tools](docs/mcp.md) for discovery, task planning,
  creation and completion, plus an interactive [terminal UI](docs/tui.md)

iOS, third-party importers, voice capture, feeds, webhooks and further API coverage
remain planned.
The [roadmap](docs/ROADMAP.md) distinguishes delivered capabilities from remaining work.

## Tech stack

| Layer | Choice |
| --- | --- |
| Sync engine | [Zero](https://zero.rocicorp.dev/) (local-first, query-based sync) |
| Backend | [Elysia](https://elysiajs.com/) on [Bun](https://bun.sh/) |
| Frontend | React 19 + shadcn/ui + Radix + Tailwind v4 |
| Auth | [Better Auth](https://www.better-auth.com/) (email + OAuth, JWT for Zero) |
| Database | PostgreSQL 18 (`wal_level=logical`) via [Drizzle ORM](https://orm.drizzle.team/) |
| Native | [Capacitor](https://capacitorjs.com/) (mobile) + [Tauri 2](https://tauri.app/) (desktop) + PWA |
| i18n | [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) |

## Run it (Docker Compose)

The `deploy/docker` stack runs the app (web UI + API served
same-origin on one port), PostgreSQL, and the Zero sync cache.
Clients collaborate through this shared server. PostgreSQL must provide logical
replication and direct connections; PGlite and other embedded databases are not
supported substitutes. See [database roles](docs/runbooks/database-roles.md).

Published images are on GHCR, so no checkout is needed to run it — but the
Compose file is in this repo, so either clone it or download that one file.

```sh
# From the repo root, create this private file once for a new installation.
(
set -euC # Refuse to overwrite an existing file.
umask 077
cat > deploy/docker/.env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 24)
DITERO_MIGRATION_DB_PASSWORD=$(openssl rand -hex 24)
DITERO_RUNTIME_DB_PASSWORD=$(openssl rand -hex 24)
BETTER_AUTH_SECRET=$(openssl rand -hex 32)
DITERO_ENCRYPTION_KEY=$(openssl rand -base64 32)
ZERO_ADMIN_PASSWORD=$(openssl rand -hex 32)
EOF
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml --profile bundled up
)
```

Then open http://localhost:3000 and sign up. The first account becomes the
owner; later ones need an invitation.

Reuse and back up that environment file for restarts and upgrades. Do not regenerate
database passwords or encryption keys for an existing volume. The file is gitignored;
mounted secrets with `_FILE` variables are also supported.

That pulls `ghcr.io/iuliandita/ditero:nightly` and `:nightly-zero`. Add `--build`
to build from this checkout instead. After tagged releases are available,
`DITERO_IMAGE_TAG` selects their matching app and Zero tags. Commit-specific
nightly tags use different suffix ordering for app and Zero, so pin those two
service images separately in a Compose override; see [image tags](RELEASING.md#channels-and-image-tags).

To reach it from anything other than the machine it runs on, set
`BETTER_AUTH_URL` and `PUBLIC_ZERO_URL` to addresses that machine's browsers can
resolve.

`BETTER_AUTH_URL` names exactly one origin, and auth routes reject every other
one with `403`. To serve the same instance at more than one address — a LAN
name and `localhost`, say — list the extras in `TRUSTED_ORIGINS`:

```sh
BETTER_AUTH_URL=http://ditero.example.lan:3000 \
TRUSTED_ORIGINS=http://localhost:3000 \
  docker compose --env-file deploy/docker/.env \
    -f deploy/docker/docker-compose.yml --profile bundled up
```

The same variable is the CORS allowlist **outside** production, where it also
grants those origins cross-origin API access. Production disables CORS outright,
so in the Compose stack it only widens the auth trusted-origin list.

### Configuration

All configuration is environment-driven. The common variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | _(required)_ | Signing secret for auth/JWTs. Generate with `openssl rand -hex 32`. |
| `ZERO_ADMIN_PASSWORD` | _(required)_ | Admin password zero-cache requires in production. Generate with `openssl rand -hex 32`. |
| `DITERO_ENCRYPTION_KEY` | _(required)_ | 32-byte Base64 key for stored replayable secrets. |
| `DITERO_MIGRATION_DB_PASSWORD` | _(required, bundled)_ | Password for the schema-owner role. |
| `DITERO_RUNTIME_DB_PASSWORD` | _(required, bundled)_ | Password for the non-owner application role. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public base URL the app is served from. |
| `TRUSTED_ORIGINS` | empty | Comma-separated extra origins auth routes accept, on top of `BETTER_AUTH_URL`. Also the CORS allowlist outside production. |
| `DITERO_DATABASE_URL` | bundled Postgres | Non-owner application Postgres DSN. |
| `DITERO_MIGRATION_DATABASE_URL` | bundled Postgres | Schema-owner migration DSN. |
| `DITERO_ZERO_DATABASE_URL` | bundled Postgres | Direct, replication-capable Zero DSN. |
| `POSTGRES_PASSWORD` | _(required, bundled)_ | Password for bundled PostgreSQL and Zero's bundled connection. |
| `DITERO_TRUSTED_PROXIES` | empty | Comma-separated CIDRs allowed to supply forwarding headers. |
| `PUBLIC_ZERO_URL` | `http://localhost:4848` | Address browsers dial zero-cache on. Served to the web client at runtime and used for the CSP. |
| `DITERO_ZERO_SHARD_SCHEMA` | `zero_0` | Schema zero-cache keeps sync bookkeeping in. Both app roles need access to it; see [database roles](docs/runbooks/database-roles.md). |
| `DITERO_IMAGE_TAG` | `nightly` | Image tag the Compose stack runs. The zero-cache image is that tag plus `-zero`. |
| `DITERO_REGISTRATION_MODE` | `bootstrap` | `open`, `bootstrap` (first account plus eligible invitations), or `closed` (eligible invitations only). |

> **Note:** the web client fetches `PUBLIC_ZERO_URL` from `/api/config` at
> startup, so one built image serves any hostname. Set it to the address
> **browsers** reach zero-cache on, not an internal service name — and expose
> that address, or sync cannot connect.

### Bundled vs. external Postgres

The `bundled` profile runs `upstream-db` (Postgres 18 with `wal_level=logical`).
To use your own Postgres instead, provide separate runtime, migration-owner, and
Zero DSNs and omit that profile:

```sh
DITERO_DATABASE_URL=postgres://runtime:pass@db.example.com:5432/ditero \
DITERO_MIGRATION_DATABASE_URL=postgres://owner:pass@db.example.com:5432/ditero \
DITERO_ZERO_DATABASE_URL=postgres://zero:pass@db.example.com:5432/ditero \
  docker compose --env-file deploy/docker/.env \
    -f deploy/docker/docker-compose.yml up --build app zero-cache
```

Reuse the private secrets file created above; replace the example DSNs with your
database credentials. The runtime role must not own tables or bypass RLS. The Zero
DSN must be direct,
non-pooled, and able to create replication slots. See [security architecture](docs/security.md),
[database roles](docs/runbooks/database-roles.md), and the
[backup/restore runbook](docs/runbooks/backup-restore.md).

### Notifications

Reminders for due tasks and habits, plus assignment, mention, and overdue
notices, delivered through a durable outbox with retries, escalation, quiet
hours, and one-tap acknowledgement. ntfy, Telegram, Discord, Slack, and email
all deliver today.

One-tap acknowledgement from the message itself works on ntfy and Telegram, and
on Discord and Slack in app mode. A pasted incoming webhook cannot carry an
interactive button on either platform, so Discord and Slack each offer a webhook
mode (send-only) and an app mode; app mode requires a public base URL for the
inbound listener and is refused at save time without one, rather than saved and
left quietly non-interactive. Telegram defaults to polling, which is outbound
only and needs no public URL, certificate, or forwarded port.

Delivery is **at-least-once, never exactly-once** — you can receive a duplicate —
and there are bounded conditions under which a notification is dropped entirely.
Reminders are **not medical-grade**. Read
[docs/notifications.md](docs/notifications.md) before relying on this for
medication, and [security architecture](docs/security.md#notification-egress-and-ntfy-topics)
before pointing a channel at a host on your own network.

All scheduler and worker knobs, with their defaults and the boot-validated
ordering constraints between them, are documented in [.env.example](.env.example).

### Encrypted attachments

Files attached to tasks, comments, and lists are encrypted on the client before upload.
The server stores and proxies only ciphertext, including encrypted filenames, declared media
types, and thumbnails. It can still see the parent record, uploader, byte counts, lifecycle
state, and storage location because authorization, quota enforcement, and garbage collection
depend on them.

The Compose default stores ciphertext on a persistent filesystem volume. S3-compatible storage
is also supported without exposing the bucket to browsers. Uploads require a live connection,
and the server cannot scan encrypted files for malware. Read the
[security boundary](docs/security.md#operator-blind-attachments),
[storage and backup runbook](docs/runbooks/attachment-storage.md), and
[key-loss runbook](docs/runbooks/e2e-key-loss.md) before enabling attachments for data that has
no other copy. All attachment configuration is documented in [.env.example](.env.example).

### Browser installation and native development apps

Production browser builds include a PWA manifest and a bounded offline public
app shell. The service worker caches static public files, with no API, auth,
Zero, or private user responses. Offline shell loading does not replace session
checks; private synced records remain in Zero's separate local storage. Updates
show a notice and reload only on user choice, after durable local sync retirement.
HTTPS and browser-secure loopback origins are supported. Browser qualification
covered installability, offline shell recovery, and manual update; it did not
perform an OS installation or test a signed-in queued Zero edit during update.

The [Android](apps/android/README.md) and [desktop](apps/desktop/README.md)
development apps support native browser-consent sign-in, scoped local storage,
and encrypted attachment upload, download/save, delete, and in-app image preview.
Encrypted files require `DITERO_E2E_ENABLED` on the server and account key enrollment.
Native credentials stay outside JavaScript; file transfers use named native HTTPS
operations and system save pickers, with complete integrity verification before
plaintext save writes. Bounded Android and Linux desktop file journeys have passed.
Android supports encrypted UnifiedPush notices and task navigation; a bounded emulator
check covered reception while stopped in deep Doze with an exempt ntfy distributor.
Linux desktop notices arrive while the app is open or minimized and can open the task.
These notices contain generic text; opening them does not complete or acknowledge a task.
The optional [Google push relay](apps/push-relay/README.md) requires separate operator
configuration and remains unqualified for real delivery. Physical-device coverage,
Windows/macOS notifications, general deep links, updates, and trusted desktop signing
remain unfinished. See each app's guide for the precise qualification limits.

### Container distribution

Nightly app and Zero images publish to GHCR for amd64 and arm64. The release workflows
provide GHCR and Docker Hub images, an Alpine app default, and a Debian app variant
when a release is cut. `:latest` and `:stable` are release channels, not current nightly
tags. Prereleases use explicit version tags and never move `latest` or `stable`.
A [Helm chart](deploy/helm/ditero/README.md) packages app and Zero with an external
PostgreSQL database. [Kustomize packages](deploy/kustomize/README.md) also support
externally managed PostgreSQL, with an optional CloudNativePG overlay. Live cluster
install, upgrade and restore qualification remains in progress. See
[RELEASING.md](RELEASING.md).

## Project status

The two highest-risk design questions were explored with runnable spikes before committing to
the build, and both are now settled in the application itself:

- **Permissions** — Zero expresses multi-workspace read isolation and role-gated writes.
- **Notifications** — durable at-least-once delivery, a single-leader scheduler, quiet hours,
  escalation, and acknowledgement from in-app or a channel button. Validated by a test rig that
  runs real replicas and kills them mid-send. All five channels — ntfy, Telegram, Discord,
  Slack, and email — deliver.
- **Operator-blind attachments** — browser-side key enrollment, recovery, workspace grants and
  forward-only rotation protect file content and names from the server and storage backend;
  filesystem and S3-compatible ciphertext stores share one authenticated transport.

Both spikes have been removed now that the production code supersedes them. The build proceeds
through a milestone roadmap on `develop`.

## Documentation

- [Development setup and checks](CONTRIBUTING.md), [changelog](CHANGELOG.md), and [release channels](RELEASING.md)
- [Security architecture](docs/security.md) and [private security reporting](SECURITY.md)
- [Notifications and delivery limits](docs/notifications.md)
- [Backup and restore](docs/runbooks/backup-restore.md), [database roles](docs/runbooks/database-roles.md), and [trusted proxies](docs/runbooks/trusted-proxy.md)
- [Data portability](docs/runbooks/data-portability.md) and [native import format](docs/runbooks/native-format.md)
- [Encrypted attachment storage](docs/runbooks/attachment-storage.md), [key-loss recovery](docs/runbooks/e2e-key-loss.md), and [key rotation](docs/runbooks/key-rotation.md)
- [Android](apps/android/README.md), [desktop](apps/desktop/README.md), [native authentication](docs/runbooks/native-authentication.md), and [native push](docs/runbooks/native-push.md)
- [Optional Google push relay](apps/push-relay/README.md) and [roadmap](docs/ROADMAP.md)

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
branch/PR workflow and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Ditero Contributors

## Find Ditero

Self-hosted todo app, local-first task manager, Todoist alternative, shared shopping
lists, chore tracker, habit tracker, family organizer, and group task management.
