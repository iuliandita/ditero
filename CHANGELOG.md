# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Expiring personal access tokens with one-time reveal, revocation and account
  deletion cleanup. Membership-scoped discovery endpoints expose workspaces,
  lists, tasks, people, labels, views and dashboards with bounded pagination and
  an OpenAPI description.
- Idempotent public task creation with explicit list, due date, assignments and
  labels, using the same permissions and mutations as the web interface.
- Bounded CLI discovery with stable JSON and eight read-only MCP tools over stdio.
  Credentials and the trusted server origin are configured at process startup.
- Named Paper and Slate light/dark palettes, validated theme JSON import/export
  and a runtime color editor with contrast guards, preview and cancellation.
  Custom palettes are currently account-scoped on this device.

### Fixed

- Hexadecimal color fields retain left-to-right notation in RTL interfaces.

## [0.0.1-alpha.1] - 2026-10-03

### Added

- Complete alpha artifact pipeline: versioned multi-architecture containers, Helm and
  Compose packages, signed independent Android APK/AAB, experimental desktop installers,
  image SBOMs/digests and download checksums.

- Shared typed lists, folders, subtasks, labels, priorities, assignments, comments,
  invitations, and managed accounts with a simplified task view.
- Saved views, board/table/calendar layouts, dashboards, keyboard shortcuts, a command
  palette, recurring tasks and habits, streaks, Karma, and a focus timer.
- Six interface languages, Arabic RTL layout, light/dark/system modes, six accent
  themes with teal as the default, reading-size presets, and independent high contrast.
- Transparent logo and wordmark assets with light/dark variants and all six accent
  palettes in `assets/brand/`.
- JSON export and reviewed, resumable native import with explicit workspace/person
  mappings and notification activation safeguards. Unsupported content is reported;
  imports do not create permissions or replay historical notifications.
- Recorded task completion history and version 2 history archives with source attribution.
  Historical storage and replay planning are implemented internally; public version 2
  import remains unavailable.
- Browser installation manifest, bounded offline public app-shell caching, and an
  explicit update prompt that waits for durable local sync retirement before reload.
- Android and desktop development apps with system-browser consent, native credential
  storage, scoped sync, and encrypted attachment transfers using system save pickers.
- Android encrypted UnifiedPush notices with task navigation, Linux desktop system
  notices while open or minimized, and a separately configured optional Google relay.
  Google delivery and broader device coverage remain unqualified.

- Notification delivery engine: leader-elected scheduler, an outbox worker on every replica
  with `FOR UPDATE SKIP LOCKED` claims, lease reclaim and fenced completion writes, a retry
  ladder bounded at 15 attempts, quiet hours, escalation to a fallback member, and per-user
  queue caps. Validated by a rig that kills real replicas mid-send.
- ntfy, Telegram, Discord, Slack, and email delivery channels, with encrypted-at-rest
  credentials, masked settings, rate-limited test sends, and provider-appropriate inbound
  acknowledgement paths.
- Acknowledgement: an in-app control and a single-use capability link in the notification
  itself, expiring after 24 hours, which terminates every sibling reminder on the occurrence.
- Assignment, `@`-mention, and overdue event notifications.
- `DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS` to allow notification egress to named private ranges,
  with never-allowable ranges enforced regardless.
- Notification documentation, including the at-least-once, drop-path, and non-medical-grade
  disclaimers: [docs/notifications.md](docs/notifications.md).
- Operator-blind attachments on tasks, comments, and lists. File content, thumbnails,
  filenames, and declared media types are encrypted in the browser; the server stores only
  ciphertext through filesystem or S3-compatible storage.
- E2E key enrollment with an independent encryption passphrase and recovery code, asynchronous
  workspace grants, invite-fragment fast paths, passphrase rewrapping, and forward-only key
  rotation after member removal.
- Account deletion safeguards that preserve shared-workspace history, require ownership transfer
  for sole owners, and require an explicit warning acknowledgement before deleting the last key
  holder for shared encrypted files.
- Repository foundation: license, contributor docs, issue/PR templates, and the
  CI/nightly/release/promote-stable workflows that implement the channel-based release flow.

### Fixed

- Removed a component-generator CLI dependency carrying an unpatched high-severity
  advisory while preserving its bundled styles and MIT license in all clients.
- Accepted offline edits persist before client shutdown, reauthentication, language
  navigation, and export. Cached nonempty lists render after an offline reload without
  requiring a fresh server response.
- Recurring series preserve their phase and finite progress through completion and skip.
- Shared dashboards refresh membership visibility and shared task completions retain
  recipient attribution.
- Native form controls follow the active theme and reading preferences.
- Notification HTTP connections pin validated DNS addresses and omit TLS SNI for IP
  endpoints.
