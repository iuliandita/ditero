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

## Deployment (planned)

Ditero will ship as multi-arch container images on GHCR and Docker Hub, with:

- Docker Compose (bundled Postgres or bring-your-own)
- Helm chart and bare Kustomize manifests for Kubernetes
- Alpine images by default, with a `-debian` variant

Images use channel tags: `:nightly` (bleeding edge), `:latest` (newest release),
`:stable` (a release that has soaked). See [RELEASING.md](RELEASING.md).

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
