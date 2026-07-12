# Security Architecture

## Trust Boundaries

- Zero sync reads are filtered server-side and writes use custom mutators. Raw CRUD mutations are disabled.
- Better Auth owns identity tables. Workspace membership and roles remain Ditero domain data.
- Backend-owned secret tables are excluded from Zero, use a non-owner database role, and force row-level security.
- User-configured outbound URLs must use `safeFetch`; it validates every DNS answer and pins one public address.

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

## Transport And Proxying

Terminate TLS at the application or a trusted reverse proxy. Set `BETTER_AUTH_URL` to the public HTTPS origin and list proxy CIDRs in `DITERO_TRUSTED_PROXIES`. Do not trust forwarding headers from arbitrary peers. See [Trusted Proxy](runbooks/trusted-proxy.md).

## Release Gates

CI runs lint, type checks, unit, integration, browser, accessibility, container, dependency, secret, misconfiguration, and static-analysis checks. Releases additionally scan built images for high and critical findings, publish an SBOM, attest provenance, and sign image digests.

Report vulnerabilities through the private process in [SECURITY.md](../SECURITY.md).
