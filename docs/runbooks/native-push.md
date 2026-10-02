# Native push delivery

The server supports one delivery target per live native device registration through
UnifiedPush Web Push or operator-project Firebase HTTP v1. Configuration returns
`deliveryReady: true` when encryption and at least one provider are configured.
This describes server support, not verified device receipt. Android background
reception and real Google relay delivery remain qualification gates in #346.

All routes require a live native session Bearer token, refuse Cookie and Origin
headers, are rate limited, and return `Cache-Control: no-store`. Browser session
tokens cannot use them. The server derives account, session, and device ownership
from the authenticated native session.

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /api/native/push/config` | No body | Configured registration providers, public VAPID key, optional Firebase project ID, and delivery readiness |
| `POST /api/native/push/register` | One provider registration below | Registration ID and provider |
| `POST /api/native/push/unregister` | `{}` | `{ "unregistered": true }` |
| `POST /api/native/push/relay/offer` | `operationId`, `installationId`, public `deviceKey` | Session-bound signed enrollment offer |
| `POST /api/native/push/relay/activate` | `offerId`, signed `receipt` | Verified relay registration |
| `POST /api/native/push/relay/update` | `registrationId`, `expectedGeneration`, signed `receipt` | Fenced receipt replacement |
| `POST /api/native/push/relay/cancel` | `offerId` | Local cancellation and durable remote cleanup |

UnifiedPush registration uses
`{ "provider": "unifiedpush", "endpoint": "https://...", "keys": { "p256dh": "...", "auth": "..." } }`.
The endpoint must pass the server's existing notification egress address policy.
The public P-256 point and 16-byte authentication secret use canonical unpadded
base64url encoding. Configure a matching VAPID pair through
`DITERO_NATIVE_PUSH_VAPID_PUBLIC_KEY`, `DITERO_NATIVE_PUSH_VAPID_PRIVATE_KEY`, and
`DITERO_NATIVE_PUSH_VAPID_SUBJECT`. The subject is a `mailto:` contact or HTTPS URL.

Direct Firebase registration uses `{ "provider": "fcm", "token": "..." }`.
It is for a custom Android build using the same Firebase project as the server
operator. `DITERO_NATIVE_PUSH_FCM_SERVICE_ACCOUNT_FILE` points to a private,
bounded service-account JSON file outside the repository. Its credentials remain
server-side; the API exposes only the public project ID. A project ID alone does
not initialize the Android Firebase SDK. The future public Google app uses an
optional hosted relay so its sending credentials are not distributed to every
self-hosted server. That relay is not implemented by this registration API.

The separate relay service and instance integration are documented in
[`apps/push-relay/README.md`](../../apps/push-relay/README.md). Configure the
instance with `DITERO_NATIVE_PUSH_RELAY_ORIGIN`, an exact HTTPS origin, and
`DITERO_NATIVE_PUSH_RELAY_RECEIPT_KEYS_FILE`, a private JSON object mapping trusted
signer IDs to public P-256 JWKs (`kty`, `crv`, `x`, `y`). The file is bounded to
16 KiB and one to eight keys. Distribute these keys through trusted operator
configuration; enrollment responses cannot establish trust. Both settings and
the existing encryption key are required. Without them, relay operations remain
unavailable. Configuring server support does not qualify the Google Android app.

Offers save encrypted sender authority before they are exposed. Activation
requires a matching trusted relay receipt and the same live native session.
Switching providers or unregistering cancels pending offers in the same
transaction. Cleanup authority survives session/account deletion until remote
retirement is confirmed. Lost generation receipts are recovered through signed
relay status only for already retired local authority; recovery never restores a
registration. Keep the configured relay origin and verification keys available
while retirement recovery remains pending.

Set the existing `DITERO_ENCRYPTION_KEY` before storing registrations. Provider
endpoints, subscription keys, and tokens are encrypted at rest and excluded from
Zero synchronization. An identical retry keeps its registration ID. Replacement
retires the old registration atomically; one native session has one registration.
Unregister affects only that session. Session, device, or account deletion cascades
to its registrations, and registration writes recheck live authority under locks.

The existing `bun run security:encrypt-channel-configs` rotation command processes
native push credentials and relay recovery snapshots as well as notification
channels. Follow the deployment's two-key rotation procedure before retiring an
old encryption key. The pass reads
locked current rows and preserves concurrent registration replacements.

Successful registration does not prove delivery, permission, distributor
availability, or background execution. Those require the native-client and real
provider qualification gates before notification availability can be advertised.

Each notification produces a separate outbox row per registration with independent
idempotency, bounded retries, and attempt history. Dispatch rechecks the live
account, session, device, registration, and current task membership. Replaced,
unregistered, expired, or revoked targets do not receive queued notifications.
Confirmed expired subscriptions retire exactly that registration; a replacement
is preserved. The existing quiet-hours, producer activation, and escalation rules
also apply to native targets. Native pushes carry no acknowledgement capability;
the authenticated app handles acknowledgement after opening.

Provider payloads contain only `version`, `notificationId`, and `registrationId`.
Task titles and details never cross the push provider. UnifiedPush uses RFC 8291
`aes128gcm` encryption and VAPID through pinned `web-push` request construction;
all outbound requests use the existing DNS-pinned, TLS-validated notification
transport and private-address policy. Firebase uses a short-lived OAuth token
scoped to messaging for the operator project, with one refresh on unauthorized
responses. Direct Firebase requires a custom APK initialized with that same
operator project's Android configuration, including a matching package identity.
A public app cannot use arbitrary self-hosted Firebase projects.

PostgreSQL integration and generated-request checks establish server behavior.
They do not establish delivery by a real UnifiedPush distributor or Google project,
Android permission handling, or background display. Those gates require actual
provider credentials and physical or qualified emulator execution. The hosted
relay source and instance integration are implemented; real Google enrollment,
background delivery, and the Google Android client remain separate qualification gates.
