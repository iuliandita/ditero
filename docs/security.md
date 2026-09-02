# Security Architecture

## Trust Boundaries

- Zero sync reads are filtered server-side and writes use custom mutators. Raw CRUD mutations are disabled.
- Better Auth owns identity tables. Workspace membership and roles remain Ditero domain data.
- Backend-owned secret tables are excluded from Zero, use a non-owner database role, and force row-level security.
- User-configured outbound URLs must use `safeFetch`; it validates every DNS answer before the request. The address pin itself is inert under Bun (issue #31) — see [Notification Egress](#notification-egress-and-ntfy-topics).

## Authentication

Email/password, passkeys, TOTP, and recovery codes are supported. Cookie-authenticated mutations require an exact configured origin. Sensitive auth routes use PostgreSQL-backed rate limits. Proxy headers are ignored unless the direct peer is within `DITERO_TRUSTED_PROXIES`.

Production defaults to `DITERO_REGISTRATION_MODE=bootstrap`: only the first account can register without an invitation. Use `closed` after provisioning when invitations are not needed.

## Stored Secrets

TOTP seeds, backup codes, OAuth tokens, JWT private keys, and backend integration credentials use AES-256-GCM envelopes. A key fingerprint identifies rotation state without storing key material. PATs are high-entropy bearer tokens and are stored only as SHA-256 hashes.

Set secrets directly or with the corresponding `_FILE` variable. When `_FILE` is used, the direct variable must be empty. Container secret files must be mounted into each service that reads them.

## Operator-Blind Attachments

Attachment content, thumbnails, filenames, declared media types, per-file data keys, and
workspace data keys are encrypted in the browser. The server and blob store receive ciphertext
and cannot decrypt it. The server deliberately retains the parent reference, workspace, uploader,
key version, lifecycle state, observed byte counts, ciphertext hash, storage key, and timestamps;
those fields are required for authorization, quota enforcement, integrity checks, and garbage
collection. Task and comment text remain server-readable so sync, filters, and reminders work.
Notification payloads may contain the server-readable parent task title, but never a decrypted
attachment filename.

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
exposing any plaintext to the user.

### Client storage and active-origin risk

Checking "remember on this device" stores the private key encrypted in IndexedDB under a
non-extractable WebCrypto key. Workspace keys remain memory-only. This is a deliberate weakening
from memory-only storage: code executing in the unlocked origin can ask the browser to decrypt,
but cannot export a reusable device key. It avoids repeated mobile passphrase prompts that train
users to choose weaker secrets. Account deletion clears the record in the browser performing the
deletion, but the server cannot remotely erase IndexedDB on another offline browser. Ordinary
sign-out does not yet clear a remembered record ([issue #254](https://github.com/iuliandita/ditero/issues/254));
use a separate browser profile on a shared machine until that is fixed.

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

**Known limitation: the DNS-rebinding pin is inert under Bun (issue #31).** `safeFetch` builds a connector that pins the request to the address it validated, but Bun's bundled `undici` shim ignores custom connectors, so the pin does not take effect on the runtime the app ships on. The policy checks still run before the request, so the address boundary itself holds. What is lost is protection against a DNS server that answers with a public address for the validation and a private one for the connection. Closing it needs a transport that honors a custom connector.

**ntfy topics are a shared secret, and a weak one.** An ntfy topic is unauthenticated and guessable by default: knowing the name is the whole access control. Ditero's acknowledge link is a bearer credential with a 24-hour life, delivered into that topic. Anyone who can read the topic can therefore complete tasks and log habit occurrences on behalf of the recipient, in a workspace they hold no membership in. This is intrinsic to how ntfy works, not a defect in Ditero, which is precisely why it has to be stated. Use a long random topic name, configure an ntfy access token, and prefer an ntfy server that requires authentication for both publish and subscribe. Treat a leaked topic as a leaked credential and rotate it.

**Channel credentials at rest.** The secret half of `notification_channel.config` (the ntfy token today) is stored in an AES-256-GCM envelope under `DITERO_ENCRYPTION_KEY`; public fields such as the server URL and topic stay readable so an operator can inspect a config. Secrets are never returned to the browser in any form, not even as ciphertext — reads hand back a masked placeholder, and writes restore the stored value from the caller's own row. A value that looks enveloped but fails to decrypt is a hard error rather than a ciphertext string shipped to a provider as a bearer token. Rotation requires running the channel-config re-encryption step; see [Field-Key Rotation](runbooks/key-rotation.md), where skipping it leaves every channel token undecryptable once the old key is retired.

## Acknowledge Capabilities

The public ack route is unauthenticated and cross-origin by necessity — the button is pressed by a push client with no session, sometimes from a third-party web UI. The token in the URL is the only credential. It is 32 random bytes, stored only as a SHA-256 hash, bound to one reminder, one recipient, and one action, single-use, and expired 24 hours after minting. A fresh capability is minted per delivery attempt and expired or consumed rows are pruned by the worker.

Redemption consumes before it validates, so a guessed token cannot be retried with a corrected binding. Every rejection class — unknown, expired, already consumed, wrong recipient, wrong action, denied completion — returns one identical response, padded to a fixed minimum duration so response time is not an oracle. The route is rate limited per client address, resolved through `DITERO_TRUSTED_PROXIES`.

## Transport And Proxying

Terminate TLS at the application or a trusted reverse proxy. Set `BETTER_AUTH_URL` to the public HTTPS origin and list proxy CIDRs in `DITERO_TRUSTED_PROXIES`. Do not trust forwarding headers from arbitrary peers. See [Trusted Proxy](runbooks/trusted-proxy.md).

## Release Gates

CI runs lint, type checks, unit, integration, browser, accessibility, container, dependency, secret, misconfiguration, and static-analysis checks. Releases additionally scan built images for high and critical findings, publish an SBOM, attest provenance, and sign image digests.

Report vulnerabilities through the private process in [SECURITY.md](../SECURITY.md).
