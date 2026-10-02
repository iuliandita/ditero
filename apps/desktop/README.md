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

## Development installers and checks

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

## Release signing is separate

The development workflow reads no signing secrets. Do not distribute its artifacts
as trusted production releases. A release workflow still needs signing,
notarization where applicable, installation tests, and platform qualification.

For macOS, replace the ad-hoc `bundle.macOS.signingIdentity` in a release-only
configuration with a Developer ID identity. Protected CI secrets should be named
`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_SIGNING_IDENTITY`.
Notarization can use `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID`, or the API
credentials `APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_KEY_PATH`. The latter
path points to a securely materialized private key on the release runner. Follow
[Tauri's macOS signing instructions](https://v2.tauri.app/distribute/sign/macos/).

For Windows, use protected `WINDOWS_CERTIFICATE` and
`WINDOWS_CERTIFICATE_PASSWORD` secrets in a separate certificate-import step,
then set `bundle.windows.certificateThumbprint`, `digestAlgorithm`, and
`timestampUrl` in a release-only configuration. These secrets are not consumed
automatically by the development workflow. Follow
[Tauri's Windows signing instructions](https://v2.tauri.app/distribute/sign/windows/).
Linux repository/package signing also remains a separate release responsibility.
Never put certificates, private keys, passwords, or personal signing identities in
tracked files. No updater or updater signing key is configured.

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

Windows and macOS runtime and credential-store behavior remain unqualified.
Offline recovery, account/server changes, revoke/restore failures, reload behavior,
worker execution, OPFS/locks, and installer execution still require platform checks.
The desktop uses each platform's native TLS trust; server certificates must also
be trusted by the user's system browser. No certificate bypass is supported.

Broader encrypted-file qualification, notification/background integration, deep
links, updater delivery, and release signing remain unfinished. Shared browser-only
settings and integrations retain the Android core's limitations. A successful installer build alone does not prove
complete desktop application delivery.
