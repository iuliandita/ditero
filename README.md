<div align="center">

# Ditero

**A self-hosted, local-first task app for the groups you share life with.**

Family, club, friend group, or small business — shared todo lists, shopping lists,
projects, chores, and habits. Fast, offline-capable, and free. Your data, your server,
no paywalls.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Status: pre-alpha](https://img.shields.io/badge/status-pre--alpha-orange)

</div>

> **Status: pre-alpha.** Ditero is under active design and construction on the `develop`
> branch. There is no installable release yet. The sync and authorization foundation is proven
> (see [project status](#project-status)); the application is being built milestone by
> milestone toward `v1.0.0`. Watch/star to follow along.

## Why Ditero

Every incumbent gates or breaks something. Ditero's design targets the gaps directly:

- **Local-first, instant UI.** Reads and writes hit a local store first and sync in the
  background — no spinners, works offline, stays fast at scale.
- **No paywalls.** Reminders, calendar views, attachments, and multi-member sharing are
  free because you host it. Nothing essential is locked behind a plan.
- **Sharing built for groups.** Shared lists with per-item assignment, a purpose-built
  shopping list, chores and habits with streaks, and fine-grained roles (a kid or junior
  member can complete but not delete).
- **Sync you can trust.** Conflict-safe, observable synchronization — the thing every
  competitor's users complain about most.
- **Yours to keep.** Self-hosted on Kubernetes, Docker, unraid, or Synology. Bring your own
  PostgreSQL or run the bundled one.

## Features (planned for v1.0)

- Unified typed lists: tasks, shopping lists, checklists, and projects
- Subtasks, labels, priorities, due dates, folders, and drag-to-reorder
- Recurring tasks and habits/chores with flexible recurrence (RFC 5545 RRULE) and streaks
- Reminders with escalation and acknowledgement, delivered to ntfy, Telegram, Discord,
  Slack, or email
- Multi-workspace sharing with Owner / Admin / Member / Viewer roles
- No-account guest links, simplified kid view, comments, and activity history
- Login with Google, GitHub, Apple, email, or a local account
- Web UI plus native apps for Android, iOS, Linux, Windows, and macOS
- Multi-language from day one and flexible theming beyond dark/light
- Saved views, dashboards, calendar/board/table layouts, focus timer, and voice capture
- JSON export plus Todoist, TickTick, Microsoft To Do, and Trello importers
- A documented REST API, agent-first CLI with MCP, and a full-screen TUI

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

The `deploy/docker` stack runs the whole spine: the app (web UI + API served
same-origin on one port), PostgreSQL, and the Zero sync cache.

Published images are on GHCR, so no checkout is needed to run it — but the
Compose file is in this repo, so either clone it or download that one file.

```sh
# From the repo root.
POSTGRES_PASSWORD=$(openssl rand -hex 24) \
DITERO_MIGRATION_DB_PASSWORD=$(openssl rand -hex 24) \
DITERO_RUNTIME_DB_PASSWORD=$(openssl rand -hex 24) \
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
DITERO_ENCRYPTION_KEY=$(openssl rand -base64 32) \
ZERO_ADMIN_PASSWORD=$(openssl rand -hex 32) \
  docker compose -f deploy/docker/docker-compose.yml --profile bundled up
```

Then open http://localhost:3000 and sign up. The first account becomes the
owner; later ones need an invitation.

That pulls `ghcr.io/iuliandita/ditero:nightly`. Set `DITERO_IMAGE_TAG` to pin a
different tag, or add `--build` to build from this checkout instead.

To reach it from anything other than the machine it runs on, set
`BETTER_AUTH_URL` and `PUBLIC_ZERO_URL` to addresses that machine's browsers can
resolve.

`BETTER_AUTH_URL` names exactly one origin, and auth routes reject every other
one with `403`. To serve the same instance at more than one address — a LAN
name and `localhost`, say — list the extras in `TRUSTED_ORIGINS`:

```sh
BETTER_AUTH_URL=http://ditero.example.lan:3000 \
TRUSTED_ORIGINS=http://localhost:3000 \
  docker compose -f deploy/docker/docker-compose.yml --profile bundled up
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
| `DITERO_REGISTRATION_MODE` | `bootstrap` | `open`, `bootstrap` (first account only), or `closed`. Invitations extend bootstrap mode in M1. |

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
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
DITERO_ENCRYPTION_KEY=$(openssl rand -base64 32) \
ZERO_ADMIN_PASSWORD=$(openssl rand -hex 32) \
  docker compose -f deploy/docker/docker-compose.yml up --build app zero-cache
```

The runtime role must not own tables or bypass RLS. The Zero DSN must be direct,
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

Files attached to tasks, comments, and lists are encrypted in the browser before upload.
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

### Planned distribution

Ditero will also ship as multi-arch container images on GHCR and Docker Hub, with
a Helm chart and Kustomize manifests for Kubernetes, Alpine images by default plus
a `-debian` variant. Images use channel tags: `:nightly` (bleeding edge),
`:latest` (newest release), `:stable` (a release that has soaked). See
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

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
branch/PR workflow and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Ditero Contributors
