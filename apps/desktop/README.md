# Desktop development

This is the work-in-progress Tauri 2 desktop core for #346. It bundles the Android
application's shared React entry and scoped sync/encryption runtime. The desktop
adapter provides the same closed native message protocol through Tauri commands
and a channel. It does not expose general HTTP, WebSocket, filesystem, or credential
store commands to JavaScript.

The Rust host selects a canonical HTTPS server, opens its grant consent page in the
system browser, exchanges the grant, and verifies the account with that server.
Session credentials, the grant verifier, and Zero JWTs remain native. JavaScript
receives public account metadata and an opaque authentication handle. Rust validates
Zero's destination, callbacks, and frames before replacing that handle with the JWT.

The native vault uses the operating system credential store: Secret Service on
Linux, Keychain on macOS, and Credential Manager on Windows. A locked or unavailable
vault shows a localized keyring requirement with Retry; start or unlock a provider
(such as GNOME Keyring or KWallet on Linux), then retry. The DEB recommends
`gnome-keyring`. There is no plaintext fallback. Bounded binary records keep each
credential blob within Windows Credential Manager's 2,560-byte limit. One protected
commit pointer publishes selection and sessions together; session references avoid
copying credentials into evidence and notification records. A process lock prevents
concurrent instances from overwriting each other's state. A bounded protected
journal tracks interrupted writes so retries reclaim uncommitted chunks. Local UI
and sync persistence retain server/account scopes. Closing waits for durable local sync retirement before
native sockets are drained and the window is destroyed; a failure keeps it open.

Recovery-code downloads use the native system save dialog and account-bound write
operations. Cancelling leaves the code visible; a failed save shows a retryable error.

## Browser-only settings

"Open in browser" in Settings opens the selected server's matching Notifications,
Security, Access tokens, Calendar subscriptions, Your data, or Danger zone section.
The system browser may require a separate sign-in. The `settings.open` native
operation accepts only those fixed destinations, bound to the current account;
it accepts no URL or credentials. The sign-in browser operation remains limited
to the pending login grant. Browser handoff failures show a retryable message.
The host waits asynchronously for the launcher for up to five seconds. A spawn
failure or non-zero exit shows that error; a launcher still running after five
seconds counts as a successful handoff because it may wait for the browser to close.

The matching `/settings/<section>` browser routes require a server version that
includes these routes; older servers still open their normal application page.
An isolated Linux runtime check confirmed the missing-keyring message, recovery
through Retry after starting an unlocked provider, and all six browser handoffs.

## Offline startup

After one complete online start, desktop can reopen the selected account's cached
data and durably saved queued edits while offline. The OS credential store retains
verified session expiry, profile, Zero endpoint, and bootstrap workspace together,
bound to the exact server, account, device, session, and credential. Older stored
sessions, including the earlier evidence format, need a complete online start once
to populate this evidence. Older desktop builds cannot read the bounded-record
format. Before a rollback to an older build, sign out stored accounts, close
Ditero, and remove its native session records using the OS credential manager;
sign in online with the older build. Keep the current build if credential cleanup
fails. The scoped task cache does not need to be cleared. Server backups do not
include these device credential records; after restoring a server backup, sign in
online again on each desktop.

Only a network failure permits cached activation, and only before the verified
session expires. Invalid credentials, failed certificate trust, HTTP refusals,
invalid responses, incomplete evidence, and failed credential-store writes never
authorize fallback. Verification and revocation are marked durably before I/O;
an interrupted or refused check requires successful online session verification
before cached activation is available again. Every authenticated native request,
including file transfers, notification polling, receipts, cleanup, and sync socket
handshakes, persists a refusal fence before I/O. A 401/403 retains that fence even
if credential deletion or later keyring writes fail. Ordinary request success
cannot clear it; a fresh session verification must succeed. Overlapping requests
cannot clear a refusal that arrives during verification. Credentials and JWTs
remain native; no JWT is restored or minted offline.

If cached activation is unavailable, reconnect and select Connect. Cached tasks
and durably saved pending edits stay on the device; retry does not clear them.
Offline access cannot discover a remote revocation until the server is reachable;
the last verified expiry bounds this access, matching Android's policy.

Unit tests cover the host decision matrix, protected evidence persistence, failed
refusal cleanup, concurrent request fences, bounded multi-account keyring records,
legacy migration, real TLS refusal classification, and the shared client startup
path. Cold offline activation still needs packaged runtime qualification on each
platform. To check it manually:

1. Sign in to an existing account online and wait for lists to synchronize.
2. Disconnect the network, edit a task, and close Ditero normally.
3. Relaunch offline. Check that cached lists and the pending edit are accessible.
4. Reconnect and confirm the queued edit synchronizes; restart to verify persistence.
5. Separately check expired evidence, revoked credentials, an untrusted certificate,
   and a locked keyring. These must refuse cached activation without deleting edits.

## Linux task links

Linux packages declare the `ditero` URL scheme. A task link has this form:

```text
ditero://task?origin=https%3A%2F%2Ftodo.example.test&taskId=TASK_ID
```

The origin is the canonical HTTPS server address, percent-encoded as one query
value. The task ID uses the existing native identifier format. Only these two
parameters are accepted; a link contains no credentials and grants no access.
Opening a link navigates to a task already visible to the current account after
sync queries finish. It never changes a task, switches servers, or starts sign-in.

A cold launch can restore only the account already selected in the OS credential
store. Sign in normally and reopen the link if that account or server is wrong.
A warm launch forwards the link to the existing process through session D-Bus.
Pending navigation stays in memory and is discarded when account or page ownership
changes. A second intent is refused while the first is pending. If acknowledgement
fails, use Retry before reopening the second link; the first task is not opened
again. The application retains its credential-store process lock and does not
register or replace URL associations at startup.

Linux scheme association and cold/warm navigation require packaged runtime
qualification. Windows and macOS link handling remain unsupported. Android
task-link behavior and qualification limits are documented in the
[Android guide](../android/README.md#task-links).

## System notifications

Linux system notifications require a notification service with action support.
Enable them in Settings after signing in. They arrive while Ditero is open or
minimized; closing the application stops reception. Windows and macOS currently
report this delivery mode as unavailable.

System popups contain generic text, never task titles or other task content.
Opening a popup resolves its destination through the current server and account.
Receiving, opening, or dismissing it does not complete a task or acknowledge a
reminder. Expired messages and revoked registrations retire their exact local
retry entries; temporary failures remain pending.

A bounded Linux host check confirmed that the system notification service accepted
a scheduled reminder. Its actual Open action resolved the canonical task and
focused the native Wayland window. The delivery receipt was stored durably, and
the task remained unfinished. Focused tests cover pending, revoked, and expired
notification cleanup. This does not qualify Windows or macOS notification behavior.

Account retirement cancels notification callbacks and attempts to remove owned
popups. Shutdown gives removal one three-second budget. A stalled system service
can still display a delayed generic popup after exit; removal is best effort.
Popups request a five-minute expiry and transient handling, which the system
service may override. In-app reminders and other configured delivery channels
retain their own behavior.

## Encrypted files

Enable `DITERO_E2E_ENABLED` on the server and enroll the account's encryption keys
before using attachments. Upload, download, delete, and in-app image previews use
the shared encrypted-file interface. Named native operations stream bounded chunks
over HTTPS without exposing a general HTTP or filesystem bridge. Transfers capture
the server, account, session, and page owner; cancellation and ownership changes
retire their capabilities and stop their I/O.

Downloads use a private, account-scoped temporary stage containing ciphertext
only. The client verifies the complete encrypted stream before any plaintext save
writes. The operating system save dialog supplies an opaque destination capability;
Rust writes a private temporary file and commits the final save atomically.
Canceled or retired operations clean up their temporary files.

Linux exposes **Export data and attachments** under **Settings > Your data** when the
native export capability is available. It prepares an exact content JSON and its
paired encrypted attachment archive, each limited to 32 MiB.
Save both files through their separate system save dialogs and retain the export
password. File source labels and upload times distinguish matching filenames.
Canceling or failing to save retains the prepared pair; retry the affected download
button without preparing the export again. Saved appears only after a confirmed write.
The fixed native export operation shares the browser export limits
and never exposes a caller-supplied network target. Archive import and recovery
remain browser-only; Windows and macOS also require the browser for archive export.

## Development installers and checks

Linux integration code can read an OS-selected JSON document through
`archive.input.*`, with a 32 MiB limit and strict UTF-8 validation. This read-only
capability does not enable native import or recovery.

The Linux `archiveMigration` development capability provides fixed job, parent,
reservation, status, recovery, and ciphertext upload operations. Upload sizes and
hashes come from a fresh server witness; uncertain writes require reconciliation
before another write. Development import controls bind a completed job to the
captured account and read its paired documents through the system chooser. The
Settings entry remains unavailable until native import and recovery journeys are
qualified.

Use Bun 1.4.2 and Rust 1.98.1, matching the CI toolchain. The official Tauri CLI,
API, and Rust runtime are pinned to 2.12.1. Install the
[Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) on your
build machine. Linux requires WebKitGTK 4.1 and GTK 3 development libraries;
Windows requires the Microsoft C++ build tools and WebView2; macOS requires Xcode
command-line tools. Linux runtime sessions require an unlocked Secret Service
provider. Packaging does not exercise the credential store.

From the repository root, install dependencies and compile the shared catalogs
once. When another repository build is compiling messages, wait for it to finish
and reuse the generated catalogs. The desktop Vite configuration does not compile
them again.

```sh
bun install --frozen-lockfile
cd apps/desktop
bun install --frozen-lockfile
cd ../..
bun run i18n:compile
bunx tsc --noEmit --project apps/desktop/tsconfig.json
bunx vitest run apps/desktop/src apps/android/src
cd apps/desktop
bun run build
cd src-tauri
cargo fmt --check
cargo test --locked
cd ..
```

Then run the package command for the current build platform:

- Linux: `bun run package:linux` creates unsigned development DEB, RPM and AppImage packages.
- Windows: `bun run package:windows` creates an unsigned development NSIS `.exe`.
- macOS: `bun run package:macos` creates a development `.app` and `.dmg` with an
  ad-hoc signature, without Developer ID signing or notarization.

These commands invoke the official Tauri CLI with `--debug` and pass `--locked`
to Cargo. Build the UI first; the CLI packages the existing `dist` assets. Output
is under `src-tauri/target/debug/bundle/`, and the executable is under
`src-tauri/target/debug/`. The Linux package uses the libraries available on its
build distribution; the Ubuntu 24.04 CI artifact is not a portable Linux binary.
The Windows installer may download the WebView2 bootstrapper when WebView2 is
absent. macOS ad-hoc artifacts can require explicit approval in Privacy & Security.

The Desktop development installers workflow runs on PRs and branch pushes to
`develop`/`main`, and supports manual dispatch. It builds Linux x64 DEB/RPM/AppImage,
Windows x64 and ARM64 NSIS, and separate macOS Apple Silicon and Intel DMGs on
native runners. Linux ARM64 and universal macOS bundles are not produced. CI uses
explicit Rust targets, so its output is under `src-tauri/target/<target>/debug/`.
The local commands above use the current native host architecture unless a target
is explicitly supplied to Tauri. Linux bundling also needs `rpm`, `patchelf` and
FUSE 2 compatibility libraries; AppStream validation uses `appstreamcli`.

Both Bun installs and Cargo resolution stay frozen. Focused adapter/native lifecycle
checks remain required. Each platform upload includes checksums and an unsigned
or ad-hoc label, and expires after seven days. Linux packages include AppStream
metadata, one visible desktop entry, icons and the MIT license.

The workflow checks the contents and x64 ELF architecture of all Linux formats,
installs the DEB with dependencies, and installs/verifies the RPM and linked
libraries in a pinned Fedora 44 container. It launches the DEB, extracted RPM and
AppImage under Xvfb on Ubuntu, requiring a Ditero window. Fedora graphical startup
remains unqualified. Windows silently installs NSIS, verifies the
installed executable matches the build and has the target PE architecture, and
requires a Ditero window. macOS mounts the DMG, copies the app, checks its native
architecture and ad-hoc signature, and checks that it survives startup. Startup
checks do not qualify a rendered signed-in interface, consent, credential storage,
upgrades or OS download trust. Diagnostics are retained for seven days.
CI disables per-format updater binary patching to preserve the Windows executable
for byte-for-byte installation checks; no automatic updater is configured.

## Manual release signing hooks

The tagged beta pipeline produces optimized Linux x86_64 DEB/RPM/AppImage,
unsigned Windows x86_64/ARM64 NSIS installers and separate ad-hoc signed macOS
Apple Silicon/Intel DMGs. It uses the same installer smoke checks as development CI.
Downloads have checksums and explicit signing labels. It does not use the
certificate-required Windows/macOS hooks below. See
[Releasing](../../RELEASING.md) for the artifact pipeline and remaining limits.

Development installer commands and CI remain unsigned/ad-hoc and read no signing
secrets. Manual release hooks perform signing preflight, build the bundled UI,
and invoke pinned Tauri 2.12.1 without `--debug`, with Cargo `--locked`.
They do not publish artifacts or configure an updater.

After frozen dependency installation and catalog compilation, set
`DITERO_RELEASE_VERSION` to a semantic version without a `v` prefix. Run the
command matching the build host from `apps/desktop`:

```sh
bun run release:linux
bun run release:windows
bun run release:macos
```

Linux builds DEB, RPM and AppImage packages. These hooks do not sign Linux packages;
release operators must produce and authenticate checksums/signatures before
publication. Package-manager trust and AppImage signing are separate from Tauri
updater signatures. Never label an unsigned Linux artifact as signature-qualified.

Windows requires an already imported, currently valid code-signing certificate
with its private key in `Cert:\CurrentUser\My`. Set
`DITERO_WINDOWS_CERTIFICATE_THUMBPRINT` to its 40 hexadecimal digits and
`DITERO_WINDOWS_TIMESTAMP_URL` to the trusted signing provider's HTTPS RFC 3161
service. The hook checks the certificate's code-signing usage and builds NSIS
with SHA-256 signing and timestamping. It does not import certificates or bypass
certificate trust. A successful signature does not guarantee SmartScreen reputation.

macOS requires an already imported `Developer ID Application` certificate. Set
`APPLE_SIGNING_IDENTITY` to its full identity, plus `APPLE_API_KEY`,
`APPLE_API_ISSUER`, and `APPLE_API_KEY_PATH` for App Store Connect notarization.
The API key must be a regular file accessible only to its owner. The hook requires
this API credential route and rejects automatic certificate import and Apple ID
credential overrides. It enables hardened runtime and builds `.app`/`.dmg`.
Ad-hoc signing is unavailable through these release commands.

The override configuration is written privately outside the checkout and removed
on success or failure. Failed commands retain a private diagnostic log outside
the checkout and report its path; signing output stays out of the console.
`TAURI_CONFIG` must be unset. Supply credentials through a
protected environment and private files, never command arguments or tracked files.

Before distributing, verify Windows application and installer signatures with
`signtool verify /pa /all`; verify macOS signing with `codesign --verify --deep
--strict`, Gatekeeper with `spctl --assess --type execute`, and notarization with
`xcrun stapler validate`. Test actual installation, launch, native credential-store
access and upgrades on each supported architecture. Successful packaging alone
is not OS-signature or runtime qualification. See the official
[Windows signing](https://v2.tauri.app/distribute/sign/windows/) and
[macOS signing](https://v2.tauri.app/distribute/sign/macos/) instructions.

Trusted desktop signing credentials, Linux package signatures, installer
qualification and updater delivery remain unfinished.

## Qualification status

The Linux development runtime has passed a bounded check in its actual WebKitGTK
webview against a trusted HTTPS server:

- System-browser grant consent, verified sign-in, and shared/private task sync.
- A task mutation confirmed in the server database.
- Non-extractable AES CryptoKey persistence through IndexedDB reopen, successful
  encryption/decryption, and refused key export.
- Cold session restore from the OS credential store, with Large text and high
  contrast preferences retained.
- A native window-close request that terminated the application within two seconds.
- Startup and the native save dialog alongside the Linux OS credential store.
- A second file uploaded with its encrypted attachment row committed on the server.
- Native download/save of a 216-byte file matching the original hash, with owner-only
  read/write permissions on the saved file.

These checks cover the Linux core journey and webview key-storage primitives.
They do not qualify full encryption enrollment/recovery or prove durable close
with queued offline edits. Focused tests separately cover protocol, credential
cleanup, vault retry, and bounded socket writes.

Theme radio controls and reading-preference controls have been corrected. An actual
WebKitGTK CSS check covered dark, light, system, Large text, and high contrast
settings; it does not qualify a new installer or a complete platform journey.

Windows and macOS have successful development builds only; actual sign-in,
credential-store access, offline behavior, and notification clicks remain unqualified.
Offline recovery, account/server changes, revoke/restore failures, reload behavior,
worker execution, OPFS/locks, and installer execution still require platform checks.
The desktop uses each platform's native TLS trust; server certificates must also
be trusted by the user's system browser. No certificate bypass is supported.

Broader encrypted-file qualification, Windows/macOS notification integration,
deep links, updater delivery, release signing, and complete installer qualification
remain unfinished. Shared browser-only settings and integrations retain the Android
core's limitations. A successful installer build alone does not prove complete
desktop application delivery.

Quick add voice dictation is unavailable in the desktop app: the shared interface detects the native bridge and shows an explanation instead of the control, and no native speech plugin exists. Use the browser; see the [voice capture guide](../../docs/runbooks/voice-capture.md).
