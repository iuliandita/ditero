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
