# Security Architecture

## Trust Boundaries

- Zero sync reads are filtered server-side and writes use custom mutators. Raw CRUD mutations are disabled.
- Better Auth owns identity tables. Workspace membership and roles remain Ditero domain data.
- Backend-owned secret tables are excluded from Zero, use a non-owner database role, and force row-level security.
- User-configured outbound URLs must use `safeFetch`; it validates every DNS answer and pins the socket to an approved address. See [Notification Egress](#notification-egress-and-ntfy-topics).

## Authentication

Email/password, passkeys, TOTP, and recovery codes are supported. Cookie-authenticated mutations require an exact configured origin. Sensitive auth routes use PostgreSQL-backed rate limits. Proxy headers are ignored unless the direct peer is within `DITERO_TRUSTED_PROXIES`.

Email sign-in combines an atomic `rate_bucket` token bucket per client IP and
trimmed, lowercased email (capacity five, refill five per minute) with Better Auth's
30-per-minute per-IP ceiling. The bounded JSON body clone is limited to 4 KiB;
bucket keys hash the address and email, and the limiter never looks up or logs
the email. Known and unknown accounts have identical bucket and 429 behavior.
IPv4-mapped addresses and IPv6 /64 allocations share identity buckets. Missing
socket peers use the unknown-client bucket and cannot supply forwarding headers.

The per-IP ceilings are 10 per minute for email sign-up, 30 per minute for each
two-factor route, and 600 per minute each for session and token refresh. Other
routes retain the default 100 per minute and existing sensitive-route overrides.
Passkey ceremonies remain at 10 per minute; the exact passkey-list read rule
precedes the wildcard and allows 100 per minute. TOTP account lockout remains at
five failures for 15 minutes. Shared-address ceilings still bound abuse across
accounts; see [Trusted Proxy](runbooks/trusted-proxy.md) for NAT and VPN guidance.

Production defaults to `DITERO_REGISTRATION_MODE=bootstrap`: only the first account
can register without an invitation. `closed` disables uninvited registration,
including the first account; eligible invitations can still admit accounts.
Optional Google sign-in creates accounts through the same registration check, so
a first Google sign-in needs the same admission as an email signup. See
[Sign-in providers](runbooks/sign-in-providers.md).

Email sign-up returns HTTP 200 with `{"token":null,"user":null}` for both a
new account and an existing email when admission is allowed. Neither response
issues cookies or a session. Sign in separately with the account password;
verification mail is optional and SMTP is not required. Existing account details
and passwords are never changed by a duplicate sign-up.

Public email sign-up accepts only email, password and display name. Avatar,
callback, remember-me and extra fields are ignored; names are normalized and
validated before account lookup. New-account persistence failures return the
same neutral response, without cookies, under the same timing floor. The server
logs persistence failures, including underlying storage errors; operators must
monitor those logs and database health because a neutral response does not
confirm that an account was created. Internal managed-account creation retains
its explicit error handling.

Registration policy is checked before account lookup, including for existing
emails. Closed and invitation-only refusals keep their localized policy codes;
they reveal admission policy (including eligible email invitations), not whether
an account exists. First-account creation remains serialized in bootstrap mode.
Valid-password attempts hash a password on new, duplicate and policy-refused
paths, and HTTP sign-up responses have a common 500 ms minimum duration.
This is timing equalization, not a constant-time guarantee: database contention,
hashing or server overload beyond that floor can still produce different latency.
Optional verification mail reaches only newly created accounts; someone with
access to that mailbox or the mail infrastructure can observe delivery. Without
proof of mailbox ownership, SMTP-free registration cannot prevent an attacker
from creating an unused address and subsequently proving that creation by signing
in with their chosen password. Rate limits bound attempts; the neutral response
does not claim to eliminate that active registration side channel.

"Forgot your password?" on the sign-in page requests a reset link. The answer is
the same whether or not the address has an account, and a server without SMTP
refuses the request with an explanation instead. The mailed link always opens the
web reset page (`/reset-password`), also for Android and desktop users, whose
sign-in already runs in the system browser. The link works once and expires
after an hour. The page keeps the token out of browser history, sets the new
password, and then sends the user to sign in: the reset itself creates no
session.

A completed reset assumes the old password may be compromised. In one database
transaction with the token use and the password change, it:

- ends every session of the account, browser and native;
- revokes every personal access token and calendar feed link;
- deletes every passkey;
- unlinks every Google or other provider sign-in, keeping only the password;
- invalidates every other outstanding reset link and pending sign-in proof of the
  account, including two-factor challenges, trusted-device grants, email OTPs and
  magic links, and account-bound passkey and provider-link challenges;
- marks the account email verified, since redeeming the emailed token proves
  control of that mailbox, in the same transaction.

If any step fails, none of them happen and the link stays usable. A reset also
succeeds when there are no other credentials or sessions to revoke. A request
that was already authenticated before the reset committed can still finish
creating a credential, so review the lists after a reset if the account was
actively in use by someone else. The reset page
lists the kinds of credentials that were removed. Sync access ends within the
revocation bound described below: new Zero tokens and requests are refused
immediately and open subscriptions close at the next revalidation. A session
started with the new password is unaffected. A provider sign-in can link again
only when the server permits implicit account linking and the provider supplies
a matching verified email for the verified local account. A server that disables implicit linking requires an explicit link from a
new authenticated session; password reset does not override that policy.

A reset does not touch inbound webhooks or notification channel credentials,
which belong to lists and workspaces rather than to signing in, or workspace
membership and encryption keys. It also keeps two-factor authentication (TOTP and
backup codes). Removing it would let anyone who controls the mailbox defeat a
second factor the owner set up. The cost: someone who had the old password could
also have enrolled their own authenticator, and the owner is then asked for a
code they don't have. Once the reset commits, a saved sign-in challenge or trusted
device cannot bypass a fresh password and second-factor check. An attacker who
knows only the old password cannot finish that pending sign-in. Password sign-in
still needs the enrolled factor or operator recovery. An operator recovers the account
after verifying the owner out of band, by deleting the account's `two_factor` row
and setting `two_factor_enabled` to false for the user. After a reset, review
inbound webhooks and channel settings for anything you did not create.

Android and desktop use explicit system-browser consent to obtain a device-bound
native session. Credentials remain in native storage. After sign-out or session/device
revocation commits, subsequent HTTP requests (including Zero query and mutation
requests) reject the old session. Already-open Zero subscriptions revalidate through
`/api/zero/query` every 30 seconds in shipped Compose, AIO, Helm and Kustomize
configurations (`ZERO_AUTH_REVALIDATE_INTERVAL_SECONDS=30`). They may receive new
rows until that check rejects the session and closes the connection. Allow for query
request and server scheduling latency beyond the 30-second interval; this is not an
instantaneous disconnect or a hard real-time deadline. Increasing or disabling the
interval lengthens that window. Previously synced or downloaded data cannot be erased.
There is no per-session server disconnect hook in the pinned Zero integration.
See [Native authentication](runbooks/native-authentication.md)
for the grant, device-session, and transport boundaries.

Invitations and managed-account admission require a shared workspace. Outstanding personal-workspace
invites cannot be redeemed or used to bypass registration restrictions. A personal workspace's
owner can remove legacy members, but cannot transfer its ownership or change membership roles.
Removing a member still requires key rotation before new encrypted uploads.
Membership removal works with the documented runtime grants, without database TEMP
privilege, and preserves assignment and notification cleanup in the same transaction.

New invitation links carry their bearer in `/accept#token=...`, keeping it out of
HTTP request URLs and referrers. Preview uses `POST /api/invite/preview` with a JSON
`token` body and a non-cacheable response. Previously sent `?token=` links still
work; the accept page replaces that query field with a fragment after capture.
The first navigation of a legacy link can still reach request logs, so existing
logs and already-shared links remain sensitive.

Encrypted invites combine `token` and `e2e` fragment fields. The accept page moves
the encrypted key fragment into its existing tab cache, retaining only the bearer
fragment for authentication reloads and interrupted claim/grant/finalize recovery.
The AEAD binding and fallback key-request flow are unchanged. Treat the complete
link as a credential; fragments can still appear in browser history and copied links.

## Stored Secrets

TOTP seeds, backup codes, OAuth tokens, JWT private keys, and backend integration credentials use AES-256-GCM envelopes. A key fingerprint identifies rotation state without storing key material. PATs are high-entropy bearer tokens and are stored only as SHA-256 hashes.

Inbound webhook secrets are separate high-entropy bearer capabilities (`ditero_whk_` prefix), stored only as SHA-256 hashes and shown once. They are accepted only in the `Authorization` header, never in URLs, and cannot authenticate as personal access tokens. A webhook can only create tasks in its fixed list, with no assignees, labels, parents or reads. Each delivery revalidates the hook, live account, membership and list under row locks, so revocation, expiry, demotion, list moves and account deletion take effect for later requests, replays included. Authentication lookup is limited by row-level security to the presented hash; failures return fixed responses that do not reveal which check failed.

Set secrets directly or with the corresponding `_FILE` variable. When `_FILE` is used, the direct variable must be empty. Container secret files must be mounted into each service that reads them.

## Operator-Blind Attachments

Attachment content, thumbnails, filenames, declared media types, per-file data keys, and
workspace data keys are encrypted on the client. The server and blob store receive ciphertext
and cannot decrypt it. The server deliberately retains the parent reference, workspace, uploader,
key version, lifecycle state, observed byte counts, ciphertext hash, storage key, and timestamps;
those fields are required for authorization, quota enforcement, integrity checks, and garbage
collection. Task and comment text remain server-readable so sync, filters, and reminders work.
Notification payloads may contain the server-readable parent task title, but never a decrypted
attachment filename.
Attachment reads recheck current membership and return the same 404 response for
foreign and missing IDs, including thumbnails and native routes.

Any current workspace member, including a Viewer, may download committed files. After
enrollment or unlock, members automatically request a grant for an existing active workspace
key they lack. A current member who already holds that key can fulfill the request when
they open Ditero and unlock encryption. Only Owners and Admins may provision or rotate
workspace keys; joining before encryption is provisioned does not change file-read access.

Each user has an X25519 identity keypair. The private key is wrapped independently under an
encryption-passphrase key and a recovery-code key. Each workspace and key version has a random
256-bit workspace data key, distributed to members with RFC 9180 HPKE base mode using
DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, and ChaCha20-Poly1305. Each attachment has a fresh
256-bit data-encryption key. These stored formats are versioned and context-bound:

| Protected value | Construction | Context binding |
| --- | --- | --- |
| Private key under passphrase | AES-256-GCM | `ditero:sk-pass:v1 \| userId` |
| Private key under recovery code | AES-256-GCM | `ditero:sk-recovery:v1 \| userId` |
| Private key on a remembered device | AES-256-GCM with a non-extractable local key | `ditero:sk-device:v1 \| userId \| deviceId` |
| Workspace data key for a member | RFC 9180 HPKE base mode | `ditero:wdk:v1 \| workspaceId \| keyVersion \| recipientUserId \| recipientPublicKeyFingerprint` |
| Attachment data key | AES-256-GCM | `ditero:dek:v1 \| workspaceId \| keyVersion \| attachmentId` |
| Filename or declared media type | AES-256-GCM | `ditero:meta:v1 \| attachmentId \| fieldName` |

The passphrase and recovery-code keys use Argon2id with independent 16-byte salts, NFC text
normalization, 64 MiB memory, three iterations, parallelism 1, and a 32-byte output. The purpose is
also included in the KDF input, so one wrap does not help attack the other. Changing the account
password does not change either E2E wrap.

File and thumbnail streams use separate AES-256-GCM keys derived with HKDF-SHA256 from the
attachment data key. Every segment binds the versioned stream header as additional data, and the
counter plus final flag form the 96-bit nonce. Downloads authenticate the complete stream before
exposing any plaintext to the user. In-memory downloads and previews have a 64 MiB cap.
Larger downloads use a user-selected file destination where the browser supports it: ciphertext
is staged in OPFS and fully authenticated in a first pass, then the same File snapshot is
decrypted again into the destination. No plaintext is staged in origin storage. A failed write
aborts the destination stream instead of committing a partial file.

### Client storage and active-origin risk

Checking "remember on this device" stores the private key encrypted in IndexedDB under a
non-extractable WebCrypto key. Workspace keys remain memory-only. This is a deliberate weakening
from memory-only storage: same-origin code can decrypt the stored record and copy the reusable
private identity key, even while the UI is locked. Non-extractability protects the wrapping key
from export, not the identity it decrypts. It avoids repeated mobile passphrase prompts that train
users to choose weaker secrets. Sign-out and account deletion clear the record in the browser
performing the action, but the server cannot remotely erase IndexedDB on another offline browser.

A device-registry entry or session revocation is not cryptographic revocation. A compromised E2E
identity must be replaced and every held workspace-key wrap moved to the new identity. Rotation
after workspace-member removal protects future uploads only. A removed member may retain old keys
or plaintext already downloaded, and Ditero cannot claw either back.

The hosted web client cannot defend against its own origin serving modified JavaScript that
captures a passphrase or plaintext while the keyring is unlocked. HPKE also provides no
out-of-band identity authentication: a malicious server can substitute a recipient public key and
receive a future grant. Public-key fingerprint verification is deferred.

### Irrecoverable states and account deletion

There is no administrator escrow or server-side reset. Losing both the encryption passphrase and
recovery code is permanent unless a remembered browser can still open the files. If every holder
of a workspace key is gone, the existing encrypted files are permanently unreadable. Database and
blob backups do not change that unless they also restore a usable member identity and that member
still has its passphrase, recovery code, or remembered browser. See
[E2E Key Loss](runbooks/e2e-key-loss.md).

Account deletion moves personal attachments into the retention-aware deletion path and preserves
shared-workspace attachments for remaining members. A sole shared-workspace owner must transfer
ownership first. Deleting the last member able to open shared encrypted files requires an explicit
key-loss acknowledgement. The account is tombstoned rather than physically removed so shared
history can retain stable author references; credentials, sessions, memberships, private settings,
notification data, and E2E key material are removed. See
[Attachment Storage](runbooks/attachment-storage.md).

Because the server cannot inspect plaintext, it cannot scan attachments for malware. Passive
raster previews are decoded and re-encoded in the client; SVG and HTML are never rendered inline.
No external human cryptographer has reviewed this implementation. Independent review remains a
release requirement for `v1.0.0`.

## Database Roles

Bundled PostgreSQL creates:

- `ditero_migrator`: owns schemas and runs migrations.
- `ditero_runtime`: handles application traffic and cannot bypass RLS.
- `postgres`: remains the Zero replication/administration connection in the bundled stack.

Production startup fails if the runtime role is a superuser, has `BYPASSRLS`, or belongs to the owner of `user_secret`.

## Notification Egress And ntfy Topics

Notification channel URLs are supplied by users, so every outbound send goes through `safeFetch`.

**Address policy.** Each DNS answer for the target host is checked before the request. Anything that is not a public unicast address is refused unless an operator explicitly allows it. Some ranges are never allowable, no matter what is configured: loopback, `0.0.0.0/8`, link-local `169.254.0.0/16` (which covers cloud instance metadata), CGNAT `100.64.0.0/10`, multicast, limited broadcast, IPv6 loopback/unspecified/link-local/multicast, and the IPv6 transition encodings (`64:ff9b::/96`, `64:ff9b:1::/48`, `2001::/32`, `2002::/16`) that can hide a private IPv4 payload inside an apparently-unicast literal. URL credentials and non-HTTP(S) protocols are refused outright, redirects are not followed, and responses are size-capped.

**Widening it.** `DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS` takes a comma-separated CIDR list and is empty by default. It can re-enable RFC1918 space and IPv6 unique-local (`fc00::/7`) — the legitimate case, an ntfy server on your own LAN. It cannot re-enable any range in the never-allowed list above, and a `/0` entry is rejected at boot because it would remove the boundary entirely.

Widening this is the operator's decision and the operator's risk. Every CIDR listed becomes reachable from any URL any user of the instance can save. On a multi-user instance that is an SSRF primitive into your internal network, granted to everyone who can reach the settings page. List the narrowest prefix that covers your ntfy host, never a whole site range.

**DNS pinning.** `safeFetch` uses Node-compatible HTTP/HTTPS requests with a custom
DNS lookup that returns only the validated address. It retains the original host
for certificate validation and sends SNI only for DNS names, not IP literals.
The transport does not resolve the hostname a second time during connection.

**ntfy topics are a shared secret, and a weak one.** An ntfy topic is unauthenticated and guessable by default: knowing the name is the whole access control. Ditero's acknowledge link is a bearer credential with a 24-hour life, delivered into that topic. Anyone who can read the topic can therefore complete tasks and log habit occurrences on behalf of the recipient, in a workspace they hold no membership in. This is intrinsic to how ntfy works, not a defect in Ditero, which is precisely why it has to be stated. Use a long random topic name, configure an ntfy access token, and prefer an ntfy server that requires authentication for both publish and subscribe. Treat a leaked topic as a leaked credential and rotate it.

**Channel credentials at rest.** Secret fields in `notification_channel.config`,
including tokens, webhook URLs, and signing secrets, use AES-256-GCM envelopes under
`DITERO_ENCRYPTION_KEY`. Public destination fields remain readable. Reads return
masked placeholders, and writes restore masked secrets only from the caller's own
row. A decryption failure is a hard error. Rotation requires the channel-config
re-encryption step in [Field-Key Rotation](runbooks/key-rotation.md) before retiring
the old key.

## Acknowledge Capabilities

The public ack route is unauthenticated and cross-origin by necessity — the button is pressed by a push client with no session, sometimes from a third-party web UI. The token in the URL is the only credential. It is 32 random bytes, stored only as a SHA-256 hash, bound to one reminder, one recipient, and one action, single-use, and expired 24 hours after minting. A fresh capability is minted per delivery attempt and expired or consumed rows are pruned by the worker.

Redemption consumes before it validates, so a guessed token cannot be retried with a corrected binding. Every rejection class — unknown, expired, already consumed, wrong recipient, wrong action, denied completion — returns one identical response, padded to a fixed minimum duration so response time is not an oracle. The route is rate limited per client address, resolved through `DITERO_TRUSTED_PROXIES`.

## Transport And Proxying

Terminate TLS at the application or a trusted reverse proxy. Set `BETTER_AUTH_URL` to the public HTTPS origin and list proxy CIDRs in `DITERO_TRUSTED_PROXIES`. Do not trust forwarding headers from arbitrary peers. See [Trusted Proxy](runbooks/trusted-proxy.md).

## Release Gates

CI runs lint, type checks, unit, integration, browser, accessibility, container, dependency, secret, misconfiguration, and static-analysis checks. Releases additionally scan built images for high and critical findings, publish an SBOM, attest provenance, and sign image digests.

Report vulnerabilities through the private process in [SECURITY.md](../SECURITY.md).

## Leaving a workspace

In Members, open your own row menu and choose Leave workspace. Personal
workspaces cannot be left. A sole shared-workspace owner must grant another
member the Owner role before leaving. Confirmation explains the loss of access,
assignment removal, retained authored content, and file-key rotation requirement.
Leaving uses the same transaction as owner-initiated member removal: affected
notification activation is blocked, ownership is reassigned to a remaining owner,
and the workspace is marked as requiring key rotation. Previously downloaded
files cannot be revoked.
