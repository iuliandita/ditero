# Native authentication handoff

This API and browser approval screen prepare native authentication. Desktop and
Android applications and native credential storage are not delivered by this slice.

The client generates a random PKCE verifier with 43 to 128 unreserved ASCII
characters, then computes its SHA-256 challenge in canonical unpadded base64url.
Only S256 is supported. The verifier stays with the client.

| Endpoint | Request | Credentials |
| --- | --- | --- |
| `POST /api/native/grants` | `{ "challenge": "...", "deviceLabel": "Phone" }` | No Cookie, Origin, or Authorization header |
| `GET /api/native/grants/preview?grantId=...` | No body | Browser session cookie; no Authorization header |
| `POST /api/native/grants/approve` | `{ "grantId": "..." }` | Browser session cookie and an allowed Origin; no Authorization header |
| `POST /api/native/grants/exchange` | `{ "grantId": "...", "verifier": "..." }` | No Cookie, Origin, or Authorization header |
| `GET /api/native/session` | No body | Native session token in the Bearer header; no Cookie or Origin header |
| `GET /api/native/token` | No body | Native session token in the Bearer header; no Cookie or Origin header |

Creation returns `grantId` and `expiresAt`. Grants expire after five minutes.
Open `/native/authorize?grantId=...` on the selected server in the system browser.
The page uses the existing sign-in flow, shows the device and signed-in account,
and requires an explicit approval. It returns no session token to the browser.
Preview exposes only the device label, expiry, and pending or approved status.
An approved grant is visible only to its approving account while the original
approving session remains live. Cancel leaves the request unapproved.
Approval derives the user and approving session from the browser, not from
request fields. A native session cannot approve another grant. There is no
caller-supplied callback URL.

Exchange consumes the approved grant before session creation. It releases its
database transaction before calling the session adapter, then checks the live
browser session, user, and original grant expiry again before linking the new
session to a device. Credentials are returned only after that link commits.
The response contains `token`, `sessionId`, `userId`, `deviceId`, and `expiresAt`.
The token is intended for native credential storage, not browser storage or logs.

A wrong verifier does not consume a valid grant. `authorization-pending` returns
409. Lock contention before consumption returns `busy` with 503 and Retry-After.
Once a claim is consumed, an issuance or binding failure requires a new grant
and approval. An uncertain commit returns no credential. Cleanup attempts delete
the created session; an unlinked orphan cannot authenticate through this API.

Native lookup requires an unexpired session, a persisted native link, a matching
unrevoked device, and a user that has not been deleted. A browser token alone does
not qualify. These checks are authoritative database reads on every lookup.
Grant and native-link tables are excluded from Zero synchronization.

The token endpoint returns a signed Zero JWT tied to the session and device.
Browser Zero tokens also carry their session identity. Both kinds expire within
five minutes, or when their session expires if sooner. The Zero query and mutation
endpoints verify the configured issuer and audience and check live session and
user state. Native tokens additionally require the exact linked, unrevoked device.
Revocation stops new query and mutation requests. It does not immediately evict
rows already cached in a client or prove an existing cache stream has closed;
the stream may remain until reconnect or token expiry.

Previously issued subject-only JWTs are refused. Existing signed-in browser
clients can refresh through the usual cookie-authenticated token endpoint.

All requests are rate limited. JSON bodies are bounded to 4 KiB and reject
unexpected fields. Responses carry `Cache-Control: no-store`. The existing
browser origin checks and cookie authentication remain in place.
