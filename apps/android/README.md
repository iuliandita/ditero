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
(`unifiedpush` or `google`). Poll state to observe asynchronous permission, distributor, and
registration results. Android 13 enable resumes only for the account that opened
the permission dialog.

Only successfully decrypted, bounded payloads with exactly `version: "1"`,
`notificationId`, and `registrationId` are accepted. The registration must match
the current native owner; recent notification IDs are deduplicated durably.
Notifications contain a generic private notice, with an immutable explicit app
launch intent. Opening a notification resolves its destination through the selected
server and account using the current native session and normal task permissions,
then navigates to the task. No received URL is accepted, and
receiving or opening a notification does not complete a task or acknowledge a reminder.

The connector and coordinator compile against the real SDK, and Java checks cover
payload rejection, durable retirement, cleanup isolation, commit failure, and
deduplication. Pending, revoked, and expired notification cleanup also has focused
test coverage. A bounded emulator check received a scheduled reminder through the
native receiver and displayed a generic system notice while the installed app was
stopped and the emulator was in deep Doze (`IDLE`). Ditero had no battery exemption;
the ntfy distributor was exempt. This qualifies only that emulator and distributor
setup. Stock power behavior, physical devices, distributor switching, interrupted
registration, and permission flows still need device qualification.

The optional Google flavor uses Firebase installation-ID registration and a
separately operated relay. Its SDK dependencies, service and attestation providers
are confined to that flavor. The `independent` flavor uses UnifiedPush and contains
no Firebase SDK classes or Google configuration. Both flavor identities remain
`io.ditero.app`; there is no application ID suffix. No Firebase project or public
relay is configured for this repository, so Google delivery remains unqualified.

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
./gradlew --no-daemon testIndependentDebugUnitTest assembleIndependentDebug
```

The resulting APK is
`apps/android/android/app/build/outputs/apk/independent/debug/app-independent-debug.apk`.
It uses Gradle's development signing configuration. Install it on an Android device or emulator
running API 24 or later with `adb install -r` followed by that APK path. Debug APKs
are test artifacts, not signed release or store distributions.

The Android workflow performs these compilation, bridge-test, and debug-build
checks and retains the APK for seven days. It does not run an emulator or validate
HTTPS consent, Keystore persistence, authenticated sync, or encryption on a device.
Those runtime checks remain part of #346.

## Signed release APK and app bundle

The tagged alpha pipeline builds the independent signed APK and AAB from the
validated release commit and publishes versioned downloads with checksums. It
requires a retained signing identity in repository Actions secrets. See
[Releasing](../../RELEASING.md) for the secret names and artifact limits.

Release packaging requires a supplied keystore. Set these environment variables
through a secret manager or protected CI environment:

- `DITERO_ANDROID_KEYSTORE_PATH`: path to the private keystore file.
- `DITERO_ANDROID_KEYSTORE_PASSWORD`: keystore password.
- `DITERO_ANDROID_KEY_ALIAS`: signing key alias.
- `DITERO_ANDROID_KEY_PASSWORD`: signing key password.

After building and syncing the bundled UI, run `./gradlew --no-daemon
assembleIndependentRelease bundleIndependentRelease` from `apps/android/android`.
The APK and AAB are under `app/build/outputs/apk/independent/release/` and
`app/build/outputs/bundle/independentRelease/`.
Missing or incomplete signing configuration fails release packaging. Debug builds
continue to use the development signing key. Keep the production keystore and
passwords outside the repository; keystore files are ignored.

Choose and back up the distribution signing identity before publishing. A debug
installation cannot be upgraded with an APK signed by a different key. These hooks
do not provision a production identity, publish to Google Play, or establish store
qualification.

## Google flavor status

The Google provider source and unit checks run without operator configuration:

```sh
./gradlew --no-daemon testGoogleDebugUnitTest compileGoogleReleaseJavaWithJavac
```

Google packaging requires private `app/src/google/google-services.json` or
`app/google-services.json`, plus `app/src/google/assets/native-relay.json`.
The relay configuration has exactly `relayOrigin` (a canonical HTTPS origin with
no path) and `receiptKeys` (a nonempty object mapping key IDs to public P-256 JWKs
with `kty`, `crv`, `x`, and `y`). Provision these trusted pins independently of the
selected Ditero server. They must never come from an enrollment response or server
discovery. Both configuration files are ignored by Git.

`assembleGoogleDebug`, `assembleGoogleRelease`, `bundleGoogleRelease` and direct
Google packaging tasks refuse missing or invalid trusted configuration. Aggregate
commands such as `assembleDebug`, `assembleRelease`, or `build` also include Google
packaging and require configuration. Runtime availability independently refuses
missing or invalid pins and missing Firebase options. Google SDK automatic
registration, notification delegation and analytics collection are disabled.
Registration begins only through the native notification controls.

Google debug builds use the App Check debug provider for development. Google
release builds include only Play Integrity attestation. Configure the Firebase
project, allowlisted debug attestation and production Play signing through private
operator setup. Do not distribute debug attestation credentials or treat a debug
registration as production qualification. Native App Check tokens, management
secrets and session credentials remain outside JavaScript.

After building and syncing the interface, configured operators can run
`assembleGoogleDebug` for development or `assembleGoogleRelease bundleGoogleRelease`
with the four release signing variables. The relay target follows captured native
account ownership and durable enrollment/retirement. Retiring an old account's
relay target does not unregister the installation's FID, because a replacement
account can still reference that installation. Pending enrollment or replacement
suppresses generic notification display until the target becomes active.

Source compilation and fixtures do not qualify real registration, App Check/Play
Integrity enrollment, Play signing, public relay delivery, or background/Doze behavior.
Those checks need an operator-configured project, a public relay and real devices.

## Task links

Implemented foundation with source, bridge and JVM unit coverage:
`ditero://task?origin=<canonical HTTPS origin>&taskId=<id>` opens an existing task in the signed-in app.

- The link carries no credential. It cannot sign in, start a connection, select a server, switch
  accounts or navigate to a login. The origin must be the selected server and its account must hold
  a verified, unexpired stored session, or the link is refused.
- `NativeTaskLink` accepts exactly one ASCII-graphic link of at most 2048 characters: the
  `ditero://task?` prefix, one `origin` that is already canonical (lower-case, no path, no default port),
  and one `taskId` that passes the push-open id rules. Both values are percent-encoded UTF-8, decoded once.
  Unknown or repeated fields, user info, fragments, backslashes, `+`, bad or double percent-encoding and
  invalid UTF-8 are refused. Intent extras are ignored, never read, and grant nothing; only the action
  and data URI count. An intent selector, clip data or MIME type is refused.
- The link waits in memory only, as one token bound to the captured account, and is never persisted.
  Native `link.read`, `link.dismiss(token)` and `link.retire` serve the existing JavaScript delivery;
  each read rechecks the page, account, session and trust. A cold start parks the link unbound and the
  next `hello` binds that one link to the new page generation. A link already bound to an earlier page is
  dropped on a reload, never handed to the new page. Sign-out, forget, revoke, a refused session, a
  server change, a new sign-in, and activity shutdown all clear it. The page opens the task only if it is
  already in its synced rows; otherwise it shows the existing unavailable message.
- Dismiss is idempotent: a well-formed body with an empty or unknown token succeeds and changes nothing,
  and an old token cannot clear a newer entry. A changed owner or page is still answered `cancelled`.
- `link.retire` and every `server.select` (same origin included) clear the slot and fence ingress, as on
  desktop. Links are refused silently until the page says a fresh `hello`; link reads never lift the
  fence. After a successful `server.select` the app therefore performs a new `hello` handshake, which
  rebinds the page generation and account handle, before it activates the session or requests a grant.
  A superseded attempt does nothing after `select`, and `connectBridge` rejects older in-flight requests
  and aborts sockets. A `linkRefused` flag in that `hello` is shown like one on a cold start.
- Refusals with a live, signed-in page reuse the desktop path: a pending entry with a null `taskId` and a
  `link.open` wake, which the page reads once and shows as unavailable. They are bound to the page
  generation, so nothing is replayed after a reload. A refusal before any page exists (cold start) is
  reported once by the next `hello` as `linkRefused` and is not repeated by state reads. A link that
  arrives while another is pending never overwrites the first token: the first is re-announced and the
  newcomer is refused visibly once the first is dismissed. A pending entry whose owner is stale is
  revalidated and cleared first, so it cannot block a new link; one that is only mid-verification stays.
  A link arriving while the page is signed out is dropped: the sign-in screen has no authenticated read
  and nothing is queued for a later sign-in.
- Verification: the stored account is never relaxed. While a check is in flight the vault reads as
  untrusted, so a warm link waits as an ownerless deferred entry, only when the in-memory session was
  already verified and the origin matches. It is never readable meanwhile. When the check ends, the link
  is promoted and announced if the vault then reads the same verified owner, otherwise it becomes a visible
  refusal. A failed check with none in flight refuses at once. Delivery otherwise rests on the in-memory
  session's `verified` flag, which a restored cached proof also sets, so a cold link can be delivered
  from restored proof before any live check; this is cached proof, not live proof, and there is no
  offline-link guarantee beyond it.
- `MainActivity` ignores a `VIEW` intent flagged `FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY`, so Recents does
  not replay an old link.
- `ACTION_VIEW` intents with the `ditero` scheme are consumed from the launch intent and from
  `onNewIntent`, and the activity intent is replaced afterwards so it does not replay.
- The startup `onNewIntent` callback leaves the launch intent intact until the native transport
  attaches; `onCreate` then consumes it under the existing recreation and history checks.

A custom scheme has no ownership verification on Android: any installed app or web page can send one,
so the design relies on the link holding no credential and being unable to change state. Verified HTTPS
App Links would need a server `assetlinks.json` and are not part of this change.

Emulator checks with a debug build exercised authenticated cold and warm task opening against a
matching backend. History-flagged links did not reopen a dismissed task, and a foreign server origin
was refused without changing the selected server or account. Earlier unauthenticated checks confirmed
that links do not sign in or select a server. The chooser and browser hand-off, rotation or process-death
recreation, actual Recents relaunch, verification-deferral timing, and physical devices still need qualification. A browser
hand-off with a selector or clip data is refused and remains unverified. The bridge and delivery hook
tests cover the JavaScript side; `NativeTaskLinkTest` covers the parser and `Slot` policy, not the full
`NativeZeroTransport` or `MainActivity` runtime. Task-link work remains open under #796 and #799; broader
device qualification stays open under #346.
Checks that need no device:

```sh
bunx vitest run apps/android/src/bridge.test.ts src/web/hooks/useNativeTaskLinks.test.ts
cd apps/android/android
./gradlew --no-daemon testIndependentDebugUnitTest --tests 'io.ditero.app.NativeTaskLinkTest'
```

## Remaining work

- Broader encrypted-file qualification on physical devices and document providers.
- Full offline recovery and account/server transition qualification on devices.
- Broader device qualification of native notification permission and UnifiedPush background delivery.
- Operator Firebase/relay setup and real Google delivery qualification.
- Store distribution and broader release installation/upgrade qualification.
- Emulator and device qualification of task links (see above), update delivery, and complete application qualification.

Some shared browser-only account settings and integrations still need explicit
native support. Keep unsupported operations unavailable until their native
transport and lifecycle behavior are implemented and tested.
