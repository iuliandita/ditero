# Native authentication handoff

Android and desktop development runtimes use this API and browser approval screen.
Their native hosts retain credentials in Android Keystore or the operating system
credential store. Complete native application delivery remains in progress; see
[Android development](../../apps/android/README.md) and
[desktop development](../../apps/desktop/README.md) for build and qualification limits.

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
| `POST /api/native/session/revoke` | No body, or an empty JSON object `{}` | Native session token in the Bearer header; no Cookie or Origin header |

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

All authentication requests are rate limited. Their JSON bodies are bounded to
4 KiB and reject unexpected fields. Responses carry `Cache-Control: no-store`. The existing
browser origin checks and cookie authentication remain in place.

## Native application operations

Two endpoints let a signed-in native client prepare its account before sync.
Both authenticate only a native session token in the Bearer header, using the
same live check as `GET /api/native/session`: an unexpired session, a native
link, an unrevoked matching device, and a user that is not deleted.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /api/native/profile` | No body; query parameters are ignored | `{ "id", "name", "email" }` |
| `POST /api/native/bootstrap` | No body, or an empty JSON object `{}` | `{ "workspaceId" }` |

Profile reads the current user fresh and returns those three fields for the
session's own user only. It never returns database rows, session or device
records, tokens, or secrets. A user deleted since authentication gets 401.

Bootstrap holds a live-user lock through the existing personal-workspace
helper, so account deletion cannot leave a newly provisioned workspace behind.
It is idempotent: repeating it returns the same workspace, and it restores a missing
owner membership, which in turn restores the sync access projection through the
existing trigger. The caller supplies no user, account, or workspace id; any
JSON key, array, non-object, malformed or non-JSON body is refused (400, or 415
for the wrong content type, 413 over 4 KiB).

Admission and errors, in order: a Cookie or Origin header of any value, even an
empty one, returns 400 `credentials-not-allowed`; the native rate limiter returns
429; a missing, malformed, browser, orphan, expired, revoked, or deleted-user
credential returns 401 `unauthorized`; then body validation. Errors use the same
`{ "code" }` shape as the rest of this API, and an unexpected failure returns a
500 category without detail. Every response carries `Cache-Control: no-store`
and none sets a cookie.

The credential boundary stays native. These endpoints do not enable a global
Bearer plugin, synthesize Cookie or Origin headers, or expose a generic
authenticated fetch. The native session token and Zero JWT remain in native
credential storage; only the profile fields above may reach JavaScript.

The development runtimes use these endpoints during verified sign-in and startup.
Platform qualification and complete application delivery remain unfinished.

## Native encryption operations

`/api/native/e2e` exposes the existing identity, workspace-key provisioning,
key-grant, rewrap, recovery, and rotation operations under native device-session
authentication. The suffixes and payloads match the browser `/api/e2e` API.
Permission checks, user-context RLS, live-user write locks, and the deployment's
encryption flag use the same handlers. Browser paths retain cookie and origin
guards; a native bearer cannot authenticate there.

A Cookie or Origin header of any value is refused before native admission.
Requests are rate limited and must carry a live native session. Only its verified
user id reaches the encryption handlers. Native responses carry
`Cache-Control: no-store`, set no cookie, and unexpected failures expose no
internal details. Parameterized workspace routes share a fixed rate-limit
identity, including their trailing-slash forms.

The native bridges select named encryption operations and keep session credentials
in native storage. These routes do not authorize an arbitrary authenticated URL
fetch or embedded remote pages.

## Native attachment operations

Enable `DITERO_E2E_ENABLED` on the server before using encrypted attachments.
`/api/native/attachments` reuses the browser attachment payloads, quotas,
reservation expiry, uploader checks, and parent-record permissions. The following
routes require a live native session in the Bearer header:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/native/attachments/config` | Read enabled storage and upload limits |
| `POST /api/native/attachments/reserve` | Reserve attachment metadata and ciphertext sizes |
| `POST /api/native/attachments/:id/upload` | Stream encrypted file bytes |
| `POST /api/native/attachments/:id/thumbnail` | Stream encrypted thumbnail bytes |
| `POST /api/native/attachments/finalize` | Commit a completed reservation |
| `POST /api/native/attachments/abort` | Abort the caller's reservation |
| `POST /api/native/attachments/delete` | Delete an authorized attachment |
| `GET /api/native/attachments/:id/download` | Stream authorized file ciphertext |
| `GET /api/native/attachments/:id/thumbnail` | Stream authorized thumbnail ciphertext |

Cookie or Origin headers are refused, requests are rate limited, and every
response carries `Cache-Control: no-store`. JSON controls reject unexpected fields
and have a 2 MiB server limit for escaped opaque metadata. Only the native bridge's
reserve control permits that larger envelope; other controls remain bounded to
8 KiB. Upload and download capabilities expose at most 32 KiB per chunk, monotonic
sequence numbers, and cancellation, without caller-selected URLs or headers.
Session credentials remain native.

Each transfer captures its server and verified account/session/page owner.
Changing ownership or revoking, forgetting, or draining that context cancels its
I/O and capabilities, including stale save-dialog completions. The system save
picker returns an opaque destination capability. Complete encrypted-stream
integrity is checked before plaintext save writes. Desktop downloads stage only
ciphertext in private scoped temporary files and commit the final selected save
atomically. Native image previews render inside the app.

Bounded Android and Linux desktop upload/save journeys have passed. Other document
providers, platforms, large-file and interruption cases still require qualification.

## Native sign-out

`POST /api/native/session/revoke` revokes the authenticated native device and
deletes its session in one live-user transaction. It accepts no caller-selected
session or device. Success returns `{ "revoked": true }`; already invalid,
expired, revoked, or deleted-user credentials return 401. Browser sessions and
other devices remain usable. New native lookups and previously issued Zero JWTs
lose authorization after commit; the existing cache-stream limitation above
still applies.

The native client must retire its local sync client before changing account
ownership and report network or local credential-cleanup failures truthfully.
Local forgetting alone does not prove server revocation. The endpoint retains
the same admission, no-store, and empty-body contract as native bootstrap.
