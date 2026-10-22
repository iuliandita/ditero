# Changelog

User-visible changes in the release candidate and published prereleases.
Downloads, checksums and signatures are on
[GitHub Releases](https://github.com/iuliandita/ditero/releases).
Back up your database and attachments before upgrading, and retain the original
encryption keys and service secrets. Breaking changes remain possible throughout
the `0.x` prereleases.

## 0.1.0-beta.1 - 2026-10-21

The first beta is a `0.x` prerelease, not a stable release. Native device/platform
qualification, trusted Windows/macOS signing, deep links and automatic updates
remain incomplete in [#346](https://github.com/iuliandita/ditero/issues/346).

- Authentication updates to Better Auth 1.7.12. Password reset opens the browser
  reset form and atomically revokes sessions, personal access tokens, calendar
  feeds, passkeys and linked sign-in accounts. Two-factor enrollment remains.
- Compatibility: operators must resolve duplicate provider account records before
  applying the new unique index; see the database upgrade guide.
- Optional sign-in adds generic OpenID Connect, Microsoft, GitHub, Discord, Apple
  and Facebook, plus operator-configured SAML single sign-on. Provider accounts
  must be explicitly linked to existing accounts from Settings.
- File import adds content-aware Todoist, TickTick, Microsoft To Do, Trello and
  generic CSV previews, with explicit loss notices. Trello attachment links stay
  as text; attachment files are not migrated. Voice capture previews tasks before
  adding them and uses the browser's supported speech service.
- Android task links retain the correct task through startup and avoid duplicate
  notification navigation.
- Desktop CI exercises runtime journeys; platform qualification remains incomplete.
- Kustomize deployments gate app startup on successful schema migrations and retain
  the deployment qualification checks.
- **Sync every device before upgrading from an alpha.** Sync moves to Zero 1.11.1,
  which starts a new local database on every browser, Android and desktop client.
  Edits made offline with an alpha that have not reached the server stay in the
  old local database and this version cannot send them. Bring each client online
  and wait until its sync indicator shows Synced before updating, especially
  Android and desktop apps used offline. If such edits are found, the beta warns on
  start; close it and follow the
  [Zero upgrade guide](docs/runbooks/database-roles.md#zero-111-upgrade-and-rollback).
- When this device cannot store changes, for example because storage is full or
  unavailable, the sync indicator says so. Edits are then kept only once they
  reach the server, and edits made while offline are refused instead of appearing
  saved.

- Releases include `ditero-VERSION-clients.tar.gz`: the CLI, stdio MCP server and
  terminal UI as JavaScript bundles with third-party notices, checksums and a
  build provenance attestation. They need a Bun you install (1.3.14 or newer) and
  stop with exit status 2 and a message on an older Bun. Standalone executables
  are not published; they remain on the roadmap.
- Breaking for scripts: `--version` of the CLI, MCP server and terminal UI now
  prints one JSON line (name, version, commit, dirty flag, target, minimum Bun and
  running Bun) instead of `ditero 0.x (...)`. Parse the JSON, or read the
  `version` field.
- Task rows use icons for personal and shared workspaces while keeping workspace
  names, translated tooltips and screen-reader descriptions.
- Google sign-in setup is documented for self-hosters. Compose now passes the
  configured Google client ID to the app so sign-in can be enabled there.
- A reusable fictional demo dataset is available for trying lists, tasks and views.
- An experimental deployment bundle uses one image for separate database,
  migration, app and sync containers. Backup and restore qualification remains open.
- Container backup components receive HTTP/2, Go 1.27.3 and compression-library
  security fixes without changing backup formats. Pinned timezone files are
  refreshed, and failed pinned downloads report which artifact failed. The
  experimental bundle uses an available zlib pin.
- The experimental bundle adds manual publication and native AMD64/ARM64 runtime
  qualification workflows with sanitized failure diagnostics. These checks do not
  establish backup/restore or production readiness.
- Source builds update Vite to 8.1.6 for its security fix. Contributor checks pin
  the integration runtime to the standalone client runtime.
- Removing a member works with a restricted database role, keeps their comments
  and content, removes their assignments and revokes their file access.
- Sync clients recover after database outages without a reload, and the server
  survives database restarts and stops cleanly within container grace periods.
- Revoked sessions stop syncing within 30 seconds. Zero waits for app migrations
  on first start, and the experimental bundle exposes its sync port.
- Google sign-in appears only when configured, and registration-policy refusals
  keep their localized message.
- Bundled database passwords may contain URL delimiters. Role initialization is
  atomic, and the bundled healthcheck reports missing roles.
- Invitation links keep their token out of request URLs and history.
- Android closes task details with Back, survives Activity teardown, downloads
  recovery codes and explains HTTPS, DNS and certificate failures. Native sign-in
  consent can switch browser accounts.
- Desktop installers cover Linux DEB, RPM and AppImage, Windows x64 and ARM64, and
  macOS Apple silicon and Intel. The desktop app explains missing keyrings, opens
  Settings links in the browser, reports a browser that fails to open, and says
  when the first start needs the server.
- Database deployment, outage recovery and Zero role guides cover PostgreSQL 15+,
  non-superuser Zero logins and migration-owner backups.
- Support and reporting guidance targets the latest published prerelease and
  `develop`/nightly, with actual version identities and private security reporting.
- Members can leave a shared workspace from their own Members row; the last owner
  transfers ownership first. Leaving keeps their authored content and requires a
  file-key rotation.
- Display names can be edited in Account settings, and sign-up fills one in from
  the email.
- Startup rejects auth secrets shorter than 32 characters, unwritable attachment
  storage, and a changed auth secret without the documented rotation.
- Household members behind one shared address no longer lock each other out of
  sign-in: email sign-in is limited per address and email, with a per-address ceiling.
- Sign-up no longer reveals whether an email is registered: accepted requests get
  the same response and the app signs in explicitly afterwards. The sign-in form
  keeps the entered email, notices and errors after an attempt.
- Wrong-account invites offer sign-out, viewers see read-only task controls with a
  reason, and members and viewers who join before files are encrypted request access.
- Reload restores the last workspace and list, and a running focus timer survives
  reload without losing or double-counting its interval. Lists created from a saved
  template keep the entered name.
- Opening or reloading the browser app without a connection shows a page that says
  Ditero needs a connection and retries on its own, instead of the sign-in form.
  Already-open tabs keep working offline and sync later. The desktop app opens
  cached data on an offline cold start for unexpired, verified sessions; older
  stored sessions need one online start first.
- A completion the server refuses shows its failure notice instead of silently
  undoing the row.
- Messages explain reminder acknowledgements, proxy upload limits, sync address
  problems, HTTP access limits, notification channel fields and TOTP network
  failures. Copy buttons only report success after copying, shortcut labels match
  the platform, long titles and attachment sizes display correctly, and CSV import
  completion takes keyboard focus.
- The Debian image uses a refreshed distroless base. The experimental bundle builds
  its backup binaries from current source and checks its bootstrap boundaries.

## 0.0.1-alpha.12 - 2026-10-09

- Attachment export explains the matching content and encrypted-file archives,
  including the separate archive password.
- Export selection shows source context and encrypted sizes to distinguish files
  with the same name.
- Linux desktop export distinguishes a canceled save dialog from a failed save, keeps
  prepared files available for retry, and shows the latest result for each file.
- Language changes wait for preferences to save before reloading, avoiding
  interrupted export bookkeeping.
- Settings keeps the section you selected highlighted when the page cannot scroll
  far enough to place it at the top. Manual scrolling resumes section tracking.

## 0.0.1-alpha.11 - 2026-10-08

- Comment attachments in native apps use the same authenticated upload path as
  task attachments, including retries.
- Browsers without private-file staging can upload smaller encrypted files using
  memory, with an 8 MiB combined limit for the file and thumbnail.
- Attachment errors explain browser limits and available recovery options.

## 0.0.1-alpha.10 - 2026-10-08

- Archive import dialogs explain why an action is unavailable and distinguish
  the archive password from the account encryption passphrase.
- File pickers show clearer selection, reading and rejection messages, with more
  readable errors in dark mode.
- Empty assignee and label controls align without a repeated Unassigned line.
  Viewers cannot edit labels; authorized writers retain access during paused imports.
- Native archive import remains unavailable in Settings while transfer and
  recovery checks are unfinished. Use the browser for archive import.

## 0.0.1-alpha.9 - 2026-10-07

- Task details use more compact metadata controls while keeping titles readable.
- Android retains a task link received during startup until the connection is
  ready to handle it. Broader device and task-link testing remains unfinished.
- Back up the database and attachments before upgrading this experimental alpha.

## 0.0.1-alpha.8 - 2026-10-07

- Linux desktop can export selected encrypted files from Settings as a paired
  content JSON file and encrypted attachment archive, using system save dialogs.
- Each exported document is limited to 32 MiB. Keep both files and store the
  archive passphrase securely; archive import and recovery still require the browser.
- Sharing encrypted workspace keys with legitimate members works with the
  restricted database accounts used by self-hosted deployments.
- Packaged deployment guides use the matching release version in their examples.

## 0.0.1-alpha.7 - 2026-10-07

- Compose honors the encrypted-attachment opt-in. Attachments remain disabled
  by default and require HTTPS or a browser-secure loopback address.
- Recovery guidance explains how to retain the original attachment configuration
  and keys. Do not replace keys or reenroll accounts to work around missing settings.
- Helm and Kustomize archive guides contain older alpha.6 example commands.
  Use `0.0.1-alpha.7` for the app and `0.0.1-alpha.7-zero` for sync instead.
- Back up the database and attachments before upgrading this experimental alpha.

## 0.0.1-alpha.6 - 2026-10-06

- An interrupted browser attachment import can reopen its original paired archive
  and recover the prepared transfer without importing the content again.
- Previously completed transfers are recognized. Replacing an interrupted or live
  transfer requires explicit confirmation; retired files count toward quota until
  cleanup finishes.
- Back up the database and attachments before upgrading this experimental alpha.

## 0.0.1-alpha.5 - 2026-10-06

- Existing encrypted attachments remain downloadable when a workspace needs
  key rotation.
- Saved content imports remain usable while their source listing is slow or
  unavailable.
- The import guide explains paired content and attachment archives and their
  recovery limits. Keep both archives and their required passphrase.
- Back up the database and attachments before upgrading this experimental alpha.

## 0.0.1-alpha.4 - 2026-10-06

- Subtasks in task details retain their saved order.
- Back up the database and attachments before upgrading this experimental alpha.
- Native platform testing, trusted Windows and macOS signing, and automatic
  updates remain unfinished. Standalone terminal downloads are not included.

## 0.0.1-alpha.3 - 2026-10-06

- Optional first-account setup offers Basic, Guided and Custom choices, plus Skip.
  Preview starter content before adding it; existing data is preserved.
- Encrypted attachment archives support resumable migration with reviewed mappings
  to destination tasks, lists and comments. Keep the paired content and file archives.
- One-way list calendar subscriptions can be created and revoked in Settings.
- Import Todoist project CSV snapshots and plain Trello board JSON after reviewing
  excluded content.
- Voice quick-add offers transcript review in browsers with local speech recognition.
  Physical microphone testing remains unfinished.
- API and terminal workflows add lists, folders, task relationships, ordering,
  comments and list-bound webhooks. Terminal clients must be run from source.
- Task context, assignee names, keyboard dragging, import/export feedback and
  comment composer focus are clearer and more consistent.
- Back up the database and attachments before upgrading. Windows installers remain
  unsigned; macOS downloads use ad-hoc signatures and are not notarized.

## 0.0.1-alpha.2 - 2026-10-04

- Personal access tokens provide revocable, expiring API access to the workspaces,
  lists and tasks your account can use.
- API and terminal workflows can create, edit, complete and delete tasks, create
  lists and shared workspaces, and export task calendars.
- Named light and dark palettes, a color editor with contrast checks, and theme
  import/export add more appearance choices. Custom palettes are account-scoped
  on the device in this release.
- Task history combines recorded changes with imported attribution. Historical
  archives and replay foundations are present; public version 2 import remains
  unavailable in this release.
- CSV imports have a review plan before changes are applied.
- Linux desktop adds authenticated task links. General native platform and
  task-link testing remains unfinished.
- Kustomize manifests and a CloudNativePG bootstrap overlay join the deployment
  options. External PostgreSQL requires encrypted connections; migrations wait for
  the database to become ready.
- Back up the database and attachments before upgrading this experimental alpha.

## 0.0.1-alpha.1 - 2026-10-03

- First public alpha with versioned server containers, Compose and Helm packages,
  signed Android APK/AAB files, and experimental Linux, Windows and macOS installers.
  Windows is unsigned; macOS is ad-hoc signed and not notarized.
- Shared task, shopping, checklist, project and habit lists, with folders,
  subtasks, labels, assignments, comments and workspace invitations.
- Saved views, board/table/calendar layouts, dashboards, keyboard shortcuts,
  recurring tasks, habit streaks, Karma and a focus timer.
- Six interface languages, including Arabic with right-to-left layout, light and
  dark modes, six accent themes, reading sizes and high contrast.
- Reviewed, resumable JSON import and export, task completion history and cached
  lists after an offline reload. Accepted edits are saved before shutdown or reload.
- Reminders through ntfy, Telegram, Discord, Slack and email, with quiet hours,
  escalation and acknowledgement. Delivery may repeat and is not medical-grade.
- Encrypted attachments on tasks, lists and comments, with account recovery codes
  and workspace key sharing. Back up the database and files together and retain keys.
- Browser installation, Android UnifiedPush notifications and Linux desktop
  notifications while open or minimized. Broader native testing, automatic updates
  and general task-link support remain unfinished.
