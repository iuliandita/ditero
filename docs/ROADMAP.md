# Roadmap

> Updated: 2026-07-07 | Status: pre-v1, building on `develop`
>
> Priorities change with feedback. This is current intent, not a promise.

## Where We Are

Ditero is a self-hosted, local-first todo app for families, clubs, friend groups, and
small businesses: shared lists, shopping lists, projects, and habit/chore tracking, with
reminders that actually fire. Web plus native apps, mobile-first, themeable, multilingual,
with a public API and push to Discord/Slack/Telegram/ntfy.

The design is locked and the two load-bearing technical risks are retired: workspace/
membership read isolation and role-gated writes are proven on the sync engine, and the full
reminder to notify to acknowledge to stop-escalation loop works end to end. The application
spine has landed on `develop` (auth issuing JWTs, live sync between two users with workspace
isolation, a list with tasks that create and toggle live, deployable via Docker Compose).
The rest of v1 is being built milestone by milestone, each producing working, testable
software on its own.

Nothing is released yet. Development happens on `develop` with `0.x.y` pre-release images;
`1.0.0` cuts to `main` when the full v1 set lands.

## What v1 Delivers

The complete feature set ships at 1.0. It is being built in this internal order to de-risk,
not shipped piecemeal.

### Core

- Local-first sync: instant optimistic UI, true offline editing, reliable reconnect.
- Unified typed lists: tasks, shopping, checklist, project, and habits, each visually
  distinct, with smart per-list icons.
- Subtasks, folders, labels, priorities, due dates, saved filters and views
  (list / board / calendar / table).
- Drag-to-reorder that is concurrent-safe, with pointer, touch, and keyboard support.
- Keep-style "completed items sink and mute" as a per-list display mode.
- Shared workspaces with roles (Owner / Admin / Member / Viewer), email + link invites,
  and an auto-created personal workspace for private lists.
- Multi-assignee tasks, @-mentions, and co-owned / rotating chores.

### Reminders that fire

- Per-item due reminders, per-habit time reminders (meds, dog walks), assignment, and
  overdue notifications.
- Per-user channel routing: ntfy, Telegram, Discord, Slack, email.
- Escalation policy (repeat N times, then fall back to another member), quiet hours, and
  acknowledgement from in-app or interactive channel buttons.

### Habits and recurrence

- Flexible recurrence (iCal RFC 5545 RRULE) shared by recurring tasks and habits.
- Habits tracked via a completion log with streaks, adherence, and history.

### Attachments

- File attachments on tasks, stored in S3-compatible object storage (MinIO, Garage,
  Hetzner, Backblaze, Cloudflare R2, AWS, and the like) or on a plain local filesystem
  volume, behind one interface. Network shares (SMB/NFS) work by mounting them at the
  filesystem path.
- Attachments are end-to-end encrypted client-side: the server and the storage backend
  only ever see ciphertext. See Security and Privacy below.

### Import and export

- One-click JSON export of your data. You own it.
- File-based importers from the common incumbents (Todoist, TickTick to start), built on a
  documented intermediate format so more sources are cheap to add.
- iCal feed export to subscribe your tasks into any calendar app.

### Surfaces

- Web / installable PWA, offline-capable.
- Native mobile (Android first, iOS later) and native desktop (Windows, Linux, macOS).
- Public REST API with OpenAPI/Swagger and personal access tokens.
- Agent-first CLI with stable `--json` output, a native MCP server for AI agents, and a
  full-screen terminal UI.

### Polish

- Keyboard-first: command palette, single-key and sequence shortcuts, opt-in vim keymap,
  fully remappable, with a cheat-sheet overlay.
- Internationalization with right-to-left support from the start.
- Themeable via design tokens; light/dark plus named themes, shareable as JSON.

## Deployment

- Published container images.
- Docker Compose (for Docker, unraid, Synology), plus a Helm chart and bare Kustomize
  manifests for Kubernetes.
- Bundle Postgres or bring your own. An all-in-one image option eases first run.

## Exploring

Ideas under consideration for after 1.0. If any of these matter to you, open an issue or
discussion.

- **Reading / media lists.** A `books` (or general collection) list kind for TBR piles,
  watchlists, and the like, with status, rating, and optional metadata lookup. The typed-
  container model already accommodates this cleanly.
- **Two-way calendar sync.** v1 already exports an iCal feed; live bidirectional sync with
  Google Calendar and Apple (CalDAV) is a larger, later step.
- **Chat commands.** Beyond reminder acknowledgement buttons, react to messages like
  `/add milk` or `/done` in a shared Telegram/Discord/Slack channel, riding the same bot
  listeners the reminder system already needs.
- **One-click live migration.** Connect an account (e.g. Todoist) and pull everything over,
  on top of the file-based importers that ship in v1.
- **Encrypted secure notes.** An opt-in end-to-end encrypted note or "vault" list kind, with
  the honest tradeoff that its contents cannot participate in server-side search or reminders.

## Future

Good ideas with no timeline yet.

- **Zero-knowledge encryption (operator-blind).** True end-to-end encryption where keys are
  derived from your password in the browser and never reach the server, so not even the
  operator can read your data. This is fundamentally in tension with server-side reminders
  and reactive sync queries, so it is proposed as an opt-in, sensitive-data path (and the
  backbone of managed hosting), not a blanket mode over all task content. Envelope encryption
  for shared workspaces (a per-workspace key wrapped per member) is part of this proposal.
- **Managed hosting.** A "we run it for you" offering alongside the free self-host, with
  strong per-tenant isolation (shared-DB row-tenancy first, dedicated DB per tenant for
  customers paying for isolation) and the zero-knowledge story above as a genuine guarantee
  for hosted, sensitive data.
- Project-management tool integrations (Trello, Linear, and friends).
- More list kinds unlocked by the typed-container model.

## Security and Privacy

Security is a first-class goal, not an afterthought.

- **Authentication:** passkeys and multi-factor from the start, social and email/password
  sign-in, session cookies that JavaScript cannot read, and CSRF protection.
- **Encryption at rest:** secrets and sensitive fields are encrypted with AES-256-GCM using a
  key derived via HKDF, with key rotation support.
- **End-to-end encryption for attachments:** files are encrypted in your browser before
  upload; neither the server nor the storage backend can read them. Shared attachments use
  envelope encryption (a per-workspace key wrapped for each member). Because keys derive from
  your password and there is no admin backdoor, a **recovery code** is issued at signup;
  losing both your password and recovery code means encrypted files cannot be recovered.
- **Hardening:** strict content-security-policy and security headers, rate limiting,
  request-time DNS pinning to prevent server-side request forgery, non-root signed container
  images, and a recurring automated security-audit pipeline.

Honest scope: on a self-hosted install you are the operator and own the box, so the server can
read the task content it needs to run sync, filters, and reminders. True "even the admin cannot
read it" zero-knowledge encryption for all content is fundamentally incompatible with server-
side reminders and reactive queries; it is reserved for sensitive opt-in data (attachments now,
encrypted notes later) and for the managed-hosting offering, where it is a genuine and honest
guarantee. Reminders are not medical-grade: on non-highly-available home infrastructure a server
that is down will not fire a reminder, and ditero is never marketed otherwise.

## Shipped Highlights

For release-by-release detail once releases begin, see [CHANGELOG.md](../CHANGELOG.md).
