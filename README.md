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
> branch. There is no installable release yet. The architecture is proven (see
> [de-risking spikes](#project-status)); the application is being built milestone by
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
- Login with Google, GitHub, Apple, email, or a local account
- Web UI plus native apps for Android, Linux, Windows (iOS/macOS to follow)
- Multi-language from day one and flexible theming beyond dark/light
- A documented REST API

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

```sh
# From the repo root. BETTER_AUTH_SECRET is required.
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f deploy/docker/docker-compose.yml up --build
```

Then open http://localhost:3000 and sign up.

### Configuration

All configuration is environment-driven. The common variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | _(required)_ | Signing secret for auth/JWTs. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_URL` | `http://localhost:3000` | Public base URL the app is served from. |
| `DITERO_DATABASE_URL` | bundled Postgres | Postgres DSN. Set to point at an external database (see below). |
| `POSTGRES_PASSWORD` | `pass` | Password for the bundled Postgres. |
| `VITE_ZERO_URL` | `http://localhost:4848` | zero-cache URL baked into the web bundle at **build** time. |
| `DITERO_DEFAULT_WORKSPACE_ID` | _(empty)_ | Optional shared workspace new users auto-join. |

> **Note:** `VITE_ZERO_URL` is compiled into the browser bundle when the image is
> built (a single-page-app limitation for this milestone). To change the
> zero-cache URL, rebuild the image with `--build-arg VITE_ZERO_URL=...`.

### Bundled vs. external Postgres

By default the stack runs a bundled `upstream-db` (Postgres 18 with
`wal_level=logical`). To use your own Postgres instead, set `DITERO_DATABASE_URL`
to its DSN (the server must have `wal_level=logical`) and skip the bundled
service:

```sh
DITERO_DATABASE_URL=postgres://user:pass@db.example.com:5432/ditero \
BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  docker compose -f deploy/docker/docker-compose.yml up --build app zero-cache
```

`DITERO_DATABASE_URL` is the single switch shared by the app and zero-cache.

### Planned distribution

Ditero will also ship as multi-arch container images on GHCR and Docker Hub, with
a Helm chart and Kustomize manifests for Kubernetes, Alpine images by default plus
a `-debian` variant. Images use channel tags: `:nightly` (bleeding edge),
`:latest` (newest release), `:stable` (a release that has soaked). See
[RELEASING.md](RELEASING.md).

## Project status

The two highest-risk design questions were validated with runnable spikes before committing
to the build:

- **Permissions** — Zero expresses multi-workspace read isolation and role-gated writes.
- **Notifications** — the reminder → channel → acknowledge → escalation loop works, with a
  clean split between backend-owned reminder state and Zero-owned task state.

Both passed. The build now proceeds through a milestone roadmap on `develop`.

## Contributing

Contributions are welcome once the spine lands. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
branch/PR workflow and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © Ditero Contributors
