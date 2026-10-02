# Native push registration

This API prepares device registrations for native notifications. Delivery,
Android background reception, and the optional hosted Google push relay remain
unfinished in #346. Configuration returns `deliveryReady: false`; clients must
not present a registered device as receiving notifications yet.

All routes require a live native session Bearer token, refuse Cookie and Origin
headers, are rate limited, and return `Cache-Control: no-store`. Browser session
tokens cannot use them. The server derives account, session, and device ownership
from the authenticated native session.

| Endpoint | Request | Result |
| --- | --- | --- |
| `GET /api/native/push/config` | No body | Configured registration providers, public VAPID key, optional Firebase project ID, and delivery readiness |
| `POST /api/native/push/register` | One provider registration below | Registration ID and provider |
| `POST /api/native/push/unregister` | `{}` | `{ "unregistered": true }` |

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

Set the existing `DITERO_ENCRYPTION_KEY` before storing registrations. Provider
endpoints, subscription keys, and tokens are encrypted at rest and excluded from
Zero synchronization. An identical retry keeps its registration ID. Replacement
retires the old registration atomically; one native session has one registration.
Unregister affects only that session. Session, device, or account deletion cascades
to its registrations, and registration writes recheck live authority under locks.

The existing `bun run security:encrypt-channel-configs` rotation command processes
native push credentials as well as notification channels. Follow the deployment's
two-key rotation procedure before retiring an old encryption key. The pass reads
locked current rows and preserves concurrent registration replacements.

Successful registration does not prove delivery, permission, distributor
availability, or background execution. Those require the native-client and real
provider qualification gates before notification availability can be advertised.
