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
editing after a cold start still needs the readiness fix tracked in #465.

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

## Remaining work

- Native file upload and download integration and device qualification.
- Full offline recovery and account/server transition qualification on devices.
- Native notification permission, background delivery, and push integration.
- Release signing, packaging, and store distribution.
- The separate desktop application runtime and delivery checks.

Some shared browser-only account settings and integrations still need explicit
native support. Keep unsupported operations unavailable until their native
transport and lifecycle behavior are implemented and tested.
