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
- Native notification permission, background delivery, and push integration.
- Release signing identity, distribution pipelines, and store distribution.
- Native deep links, update delivery, and complete application qualification.

Some shared browser-only account settings and integrations still need explicit
native support. Keep unsupported operations unavailable until their native
transport and lifecycle behavior are implemented and tested.
