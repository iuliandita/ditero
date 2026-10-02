# Android development

This is a work-in-progress Android application core for Ditero (#346). It bundles the
shared interface with Capacitor and uses native transports for authenticated sync
and supported encryption operations. A successful APK build does not qualify the
complete native application or its behavior on devices.

The app connects to an HTTPS Ditero server with a certificate trusted by Android
and the system browser. Sign-in opens the server's consent page in the system
browser, then exchanges the approved grant through the native transport. Native
session credentials are encrypted with an Android Keystore key and remain outside
the JavaScript interface. Local sync, encryption keys, staged ciphertext, hints,
recent items, and navigation preferences use scopes derived from the canonical
server origin and the server-verified account. The browser application retains its
existing storage keys.

A warmed account can reopen cached views offline while its complete, previously
verified native session evidence remains unexpired. That evidence is encrypted
with the session and bound to the selected server, account, and session. Only
network failures permit this fallback; invalid credentials, trust failures,
expired evidence, and failed revocation storage stay unavailable. Offline task
editing and account/server transitions still require broader device qualification.

## Encrypted files

Enable `DITERO_E2E_ENABLED` on the server and enroll the account's encryption keys
before using attachments. Upload, download, delete, and in-app image previews use
the shared encrypted-file interface. The native host streams bounded chunks over
HTTPS through named attachment operations. Credentials stay native, and each
transfer captures its server, account, session, and page owner; cancellation or
ownership changes stop the transfer.

Saving opens Android's system document chooser. The client verifies the complete
encrypted stream before writing plaintext to the selected document. A bounded
emulator check uploaded a file and saved it through the Storage Access Framework;
the saved 216-byte file matched the original. This does not qualify all document
providers, file sizes, interruption paths, or physical devices.

## Background reminders

The Android host uses UnifiedPush connector 3.3.5. Install a compatible distributor
such as ntfy and enable native push delivery on the selected Ditero server with
its Web Push VAPID configuration. Enabling reminders explicitly requests Android
13 notification permission and opens distributor selection when required. Denied
permission, a missing distributor, an unavailable server provider, failed
registration, and pending cleanup have separate states. Only a confirmed server
registration is active.

Open Settings, then Notifications, and use "Enable phone notifications" under
"On this phone". "Allow notifications" opens Android's permission prompt;
"Refresh status" checks enrollment, and "Turn off" retires this phone's
subscription. These controls are available only in the Android app.

Reception runs in a native service without an Activity or WebView. A durable random
subscription instance binds callbacks to an encrypted snapshot of the selected
server, account, native session, and device. Session expiry uses the native session
lifetime. Disable, sign-out, account replacement, and server selection retire that
instance before cleanup; captured unregister requests run after pending registration
requests and retain retry evidence across process death. One-off WorkManager
maintenance replays encrypted pending registrations and retired-owner cleanup; it
does not poll for reminders or create periodic reminder jobs. Replacement subscriptions
wait for old cleanup. Credentials, distributor endpoints, and encryption keys are
never returned to JavaScript.

The fixed native bridge operations are `push.state`, `push.enable`, `push.disable`,
and `push.permission`. Each requires the current main frame, page generation,
and opaque auth handle in `id`. No caller body, endpoint, or URL is accepted.
Replies include `state`, `permission` (`granted` or `denied`), and `provider`
(`unifiedpush`). Poll state to observe asynchronous permission, distributor, and
registration results. Android 13 enable resumes only for the account that opened
the permission dialog.

Only successfully decrypted, bounded payloads with exactly `version: "1"`,
`notificationId`, and `registrationId` are accepted. The registration must match
the current native owner; recent notification IDs are deduplicated durably.
Notifications contain a generic private notice, with an immutable explicit app
launch intent. Tapping currently opens the app shell. Notification lookup,
authorization, and task navigation remain unimplemented; no received URL is opened.

The connector and coordinator compile against the real SDK, and Java checks cover
payload rejection, durable retirement, cleanup isolation, commit failure, and
deduplication. Background delivery, distributor switching, interrupted registration,
and permission flows still need device qualification. An optional Google relay is
planned as a separate slice; this build includes no Firebase SDK or Google config.

## Build a debug APK

Install Bun 1.4.2, Java 21, and the Android SDK command-line tools. Set `JAVA_HOME`
to Java 21 and `ANDROID_HOME` to the SDK directory. Accept the Android SDK licenses
with `sdkmanager --licenses`, then install the required packages:

```sh
sdkmanager --install "platform-tools" "platforms;android-36" \
  "build-tools;35.0.0" "build-tools;36.0.0"
```

From the repository root:

```sh
bun install --frozen-lockfile
cd apps/android
bun install --frozen-lockfile
cd ../..
bun run i18n:compile
bunx tsc --noEmit --project apps/android/tsconfig.json
bunx vitest run apps/android/src/bridge.test.ts
cd apps/android
bun run build
bun run sync
cd android
./gradlew --no-daemon assembleDebug
```

The resulting APK is
`apps/android/android/app/build/outputs/apk/debug/app-debug.apk`. It uses Gradle's
development signing configuration. Install it on an Android device or emulator
running API 24 or later with `adb install -r` followed by that APK path. Debug APKs
are test artifacts, not signed release or store distributions.

The Android workflow performs these compilation, bridge-test, and debug-build
checks and retains the APK for seven days. It does not run an emulator or validate
HTTPS consent, Keystore persistence, authenticated sync, or encryption on a device.
Those runtime checks remain part of #346.

## Signed release APK and app bundle

Release packaging requires a supplied keystore. Set these environment variables
through a secret manager or protected CI environment:

- `DITERO_ANDROID_KEYSTORE_PATH`: path to the private keystore file.
- `DITERO_ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `DITERO_ANDROID_KEY_ALIAS`: signing key alias.
- `DITERO_ANDROID_KEY_PASSWORD`: signing key password.

After building and syncing the bundled UI, run `./gradlew --no-daemon
assembleRelease bundleRelease` from `apps/android/android`. The APK and AAB are
under `app/build/outputs/apk/release/` and `app/build/outputs/bundle/release/`.
Missing or incomplete signing configuration fails release packaging. Debug builds
continue to use the development signing key. Keep the production keystore and
passwords outside the repository; keystore files are ignored.

Choose and back up the distribution signing identity before publishing. A debug
installation cannot be upgraded with an APK signed by a different key. These hooks
do not provision a production identity, publish to Google Play, or establish store
qualification.

## Remaining work

- Broader encrypted-file qualification on physical devices and document providers.
- Full offline recovery and account/server transition qualification on devices.
- Device qualification of native notification permission and UnifiedPush background delivery.
- Optional Google relay integration and authorized notification tap resolution.
- Release signing identity, distribution pipelines, and store distribution.
- Native deep links, update delivery, and complete application qualification.

Some shared browser-only account settings and integrations still need explicit
native support. Keep unsupported operations unavailable until their native
transport and lifecycle behavior are implemented and tested.
