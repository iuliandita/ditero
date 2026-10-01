# Native authentication handoff

This API prepares native authentication. Desktop and Android applications,
browser approval screens, native credential storage, and native Zero tokens are
not delivered by this slice.

The client generates a random PKCE verifier with 43 to 128 unreserved ASCII
characters, then computes its SHA-256 challenge in canonical unpadded base64url.
Only S256 is supported. The verifier stays with the client.

| Endpoint | Request | Credentials |
| --- | --- | --- |
| `POST /api/native/grants` | `{ "challenge": "...", "deviceLabel": "Phone" }` | No Cookie, Origin, or Authorization header |
| `POST /api/native/grants/approve` | `{ "grantId": "..." }` | Browser session cookie and an allowed Origin; no Authorization header |
| `POST /api/native/grants/exchange` | `{ "grantId": "...", "verifier": "..." }` | No Cookie, Origin, or Authorization header |
| `GET /api/native/session` | No body | Native session token in the Bearer header; no Cookie or Origin header |

Creation returns `grantId` and `expiresAt`. Grants expire after five minutes.
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

All requests are rate limited. JSON bodies are bounded to 4 KiB and reject
unexpected fields. Responses carry `Cache-Control: no-store`. The existing
browser origin checks and cookie authentication remain in place.
