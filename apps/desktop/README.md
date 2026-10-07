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
vault fails explicitly; there is no plaintext fallback. A single protected record
commits selection and sessions together, and a process lock prevents concurrent
instances from overwriting each other's state. Local UI and sync persistence retain
server/account scopes. Closing waits for durable local sync retirement before
native sockets are drained and the window is destroyed; a failure keeps it open.

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

Linux also supports **Export selected files** in Settings. It prepares an exact
content JSON and its paired encrypted attachment archive, each limited to 32 MiB.
Save both files through their separate system save dialogs and retain the archive
passphrase. The fixed native export operation shares the browser export limits
and never exposes a caller-supplied network target. Archive import and recovery
remain browser-only; Windows and macOS also require the browser for archive export.

## Development installers and checks

Linux integration code can read an OS-selected JSON document through
`archive.input.*`, with a 32 MiB limit and strict UTF-8 validation. This read-only
capability does not enable native import or recovery.

The Linux `archiveMigration` development capability provides fixed job, parent,
reservation, status, recovery, and ciphertext upload operations. Upload sizes and
hashes come from a fresh server witness; uncertain writes require reconciliation
before another write. These transport primitives do not enable archive import or
recovery in the app interface.

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
bunx vitest run apps/desktop/src/transport.test.ts
cd apps/desktop
bun run build
cd src-tauri
cargo fmt --check
cargo test --locked
cd ..
```

Then run the package command for the current build platform:

- Linux: `bun run package:linux` creates an unsigned development `.deb`.
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

The Desktop development installers workflow builds one package on each of Linux,
Windows, and macOS. It freezes both Bun installs and Cargo resolution, runs the
focused adapter/native lifecycle checks, and uploads artifacts labeled as
unsigned or ad-hoc development builds. It does not publish a release or run an
interactive consent/credential-store journey. The macOS CI job builds for its
runner's native architecture; it does not produce a universal application.

## Manual release signing hooks

The tagged alpha pipeline separately produces optimized Linux x86_64 DEB/AppImage,
unsigned Windows x86_64 installers and ad-hoc signed macOS Apple Silicon DMGs.
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

Linux builds `.deb` and AppImage packages. These hooks do not sign Linux packages;
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
