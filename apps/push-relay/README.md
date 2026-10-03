# Optional Google push relay

This separately deployed Bun HTTP service and its instance integration are implemented for the optional Google Android client. The instance source includes session-bound offer consumption, trusted receipt verification and retirement recovery. Configure the trusted relay origin and receipt key ring as described in the [native push runbook](../../docs/runbooks/native-push.md). Google Android enrollment and actual provider qualification remain required before enabling Google push availability. Independent self-hosted push remains supported.

The service has no delivery queue. It synchronously reports FCM acceptance; the instance notification outbox owns subsequent attempts. Acceptance is not device delivery. A process crash after provider acceptance but before the database commit can duplicate a message. Android must enforce the current local owner and registration before displaying generic notification copy. The three-field payload carries no delivery generation, so a previously accepted generic reminder for the same registration can arrive after FID replacement. Send and retirement operations remain generation-fenced; opening always rechecks live instance authority.

## Run and deploy

Use a dedicated PostgreSQL database. Provision a migration owner and a separate login role with no superuser, BYPASSRLS, CREATEROLE, CREATEDB, database CREATE, schema CREATE, table ownership or migration-table write authority. Revoke public schema privileges in this dedicated database. The migration grants the runtime role only schema usage, relay-table data access and schema-version read access. Runtime startup checks these boundaries and never runs migrations.

Supply database credentials through a private environment file or secret injection, never command arguments. Set `RELAY_MIGRATOR_DATABASE_URL` and `RELAY_RUNTIME_ROLE` for migration, then use the runtime connection only for the server:

```sh
bun run push-relay:migrate
bun run push-relay:start
```

`GET /healthz` reports process liveness. `GET /readyz` performs a read-only schema-version query with a two-second response bound and returns 200 or 503. Neither endpoint discloses configuration or writes operation metadata.

The server requires `RELAY_DATABASE_URL` and `RELAY_CONFIGURATION_FILE`. `PORT` defaults to 8080. Terminate HTTPS at a reverse proxy and forward only to the private relay listener. Enrollment IP quotas use the direct socket peer, ignoring forwarded headers; a proxy therefore shares an IP bucket unless the deployment uses direct peers. Select this deployment arrangement deliberately.

The configuration is a JSON file, at most 64 KiB, readable only by its owner. It contains these required fields:

| Field | Operator input |
| --- | --- |
| `origin` | Exact public HTTPS origin, without a trailing slash or path |
| `projectNumber` | Firebase numeric project identifier |
| `projectId` | Firebase project ID |
| `appIds` | Explicit approved Android App Check application IDs in that project |
| `clientEmail`, `privateKey` | Matching project service-account email and RSA PEM key |
| `encryptionKey` | Canonical base64 encoding of 32 random bytes |
| `receiptKey` | P-256 private JWK with exactly `kty`, `crv`, `x`, `y`, `d`, `kid` |
| `receiptVerificationKeys` | Pinned public P-256 JWKs with exactly `kty`, `crv`, `x`, `y`, `kid`, including the active signer |

`nextEncryptionKey` optionally permits old/new encrypted-field reads while writing with the next key. Preserve old keys until stored FIDs and pending challenges have been reencrypted through an operator-controlled migration. The runtime does not retire or rewrite old encryption keys automatically. Receipt verification keys must be distributed through trusted client configuration, including rotation overlap; clients must never learn a trusted signing key from an enrollment response. The service validates the configured active signing key against that ring.

Build the root-context container with `apps/push-relay/Dockerfile`. It runs as a nonroot user, includes the migration command separately, and uses the existing dependency lock. Mount the private configuration file read-only and supply runtime credentials separately. No production Firebase project, public origin, Play signing or enrolled App Check identity is supplied by this source.

## Closed request protocol

All routes are JSON POSTs. Requests, provider responses and App Check JWKS responses are bounded to 16 KiB. The request deadline is 10 seconds. Only the fixed Google OAuth, App Check JWKS and FCM hosts are contacted, through the application's public-address protected transport. No request supplies a URL or a project authority.

Every request includes `installationId`, `targetId`, `registrationId` and `operationId`. New installation, target, offer, operation, proof nonce, challenge and credential values are canonical base64url encodings of 32 random bytes, generated and durably saved by their requester before making the request. Existing application `registrationId` and ordinary `notificationId` values retain their original bounded opaque form, including UUIDs. They are never translated or remapped by this service.

Bodies are closed objects; extra fields are refused. Device requests carry `deviceProof` and `appCheck`. Send requests carry `senderProof`. Retirement carries one of the two authorities. The semantic digest is SHA-256 of recursively key-sorted canonical JSON of the parsed closed body, excluding `deviceProof`, `senderProof` and `appCheck`. Renewed proofs and attestation tokens therefore do not change the operation. Other body changes do.

Proofs are ES256 compact JWTs with exactly header `alg: ES256`, `typ: ditero-relay-proof+jwt`, and `kid` equal to the verified public key's RFC 7638 thumbprint. Claims are exactly `aud`, `iat`, `exp`, `method`, `path`, `operationId`, `digest` and `nonce`. Audience is the configured origin, method is POST, path is the exact route, and operation/digest match the body. Lifetimes are at most 60 seconds with 5 seconds of clock tolerance. Public JWKs contain exactly `kty: EC`, `crv: P-256`, `x` and `y`. Private or embedded trust material is refused.

| Route | Additional body fields and behavior |
| --- | --- |
| `/v1/enroll` | `deviceKey`, `senderKey`, `managementSecret`, `sendCapability`, `offerId`, `offer`, `fid`; requires device proof and App Check, plus the sender-signed offer. No sender private key or redundant request signature is shared with Android. |
| `/v1/confirm` | `managementSecret`, `generation`, `challenge`; proves receipt of the delivered challenge. Initial generation is 1. Pending FID replacement confirmation uses the next generation and the newly saved pending management secret. |
| `/v1/send` | `sendCapability`, current `generation`, `priority` (`normal` or `high`), and closed `data` with exactly `version: "1"`, `notificationId`, `registrationId`; sender proof required and payload registration must equal the stored registration. |
| `/v1/manage/rotate` | `managementSecret`, current `generation`, `newManagementSecret`; device proof and App Check, advances credential version without advancing delivery generation. |
| `/v1/manage/replace-fid` | `managementSecret`, current `generation`, `newManagementSecret`, `fid`; stages encrypted FID/credential/challenge and sends to that FID. Existing FID and credentials stay current until successful confirmation. |
| `/v1/manage/retire` | Exact current `generation` and either `managementSecret` with device proof/App Check or `sendCapability` with sender proof; an old generation cannot retire a newer replacement. |
| `/v1/targets/status` | `sendCapability` and sender proof; returns a signed `target-status` receipt with current generation/state and immutable target bindings. This read allocates no operation/nonce rows and has a separate 120-per-target-hour admission quota. It permits verified current-generation retirement after a lost replacement receipt. |
| `/v1/operations/status` | `managementSecret`, `queriedOperationId`, device proof and App Check; returns only the queried operation's saved outcome. Its captured predecessor management hash can recover that outcome after rotation, without authorizing any new action. |

The signed offer uses header type `ditero-relay-offer+jwt` and the per-offer sender-key thumbprint as `kid`. Its exact claims are `aud`, `iat`, `exp`, `installationId`, `offerId`, `targetId`, `registrationId`, `senderKey`, `deviceThumbprint`, and `sendCapabilityHash`. It expires within five minutes and binds the configured relay origin. Hashes are SHA-256 with prefixes `ditero:push-relay:v1:send:` or `ditero:push-relay:v1:management:`. The relay stores credential hashes only. Offers prove key possession; they do not prove a session on an arbitrary self-hosted instance. Activation must separately consume a live, session-bound, one-use instance offer.

The relay commits the encrypted target and unpredictable challenge before sending the challenge. Challenge messages are normal-priority, data-only FCM messages with exactly the same three payload fields and a 300-second TTL. The challenge is the delivered `notificationId`; API responses never reveal it. Android must answer only for its locally initiated, still-current pending registration. App Check validates RS256 signatures through the fixed official JWKS endpoint, approved project audience/issuer, application subject and expiration. App Check supplies abuse evidence and never substitutes for device proof or delivered-FID possession. Device signatures do not attest hardware or nonexportability.

Confirmed receipts use ES256 with type `ditero-relay-receipt+jwt`, configured signer `kid`, issuer/audience equal to the origin and issued time. Accepted send receipts additionally bind `kind: "accepted"`, `operationId` and the exact semantic `digest`, and are stored with the operation outcome for replay. Receipts bind offer ID/expiry, target ID, unchanged application registration ID, installation ID, sender key/thumbprint, device thumbprint, origin, domain-separated FID hash, delivery generation, credential version and send-capability hash. Raw FIDs, credentials and challenges never appear in receipts. Client trust comes from its configured key ring. Receipt binding alone does not authorize application activation.

## Recovery and limits

Responses contain a typed `kind`, and when appropriate `generation`, `credentialVersion` and signed `receipt`. They never return generated credentials. Exact operation retries recover accepted/terminal saved results without resubmitting to FCM. Retryable/quota outcomes resume the same operation and immutable body after current authority, state, generation and quotas are rechecked. Reusing the operation ID with different semantics returns 409. New send requests refused by quota admission allocate neither operation nor proof-nonce rows; they remain unadmitted and can be resubmitted unchanged once capacity returns. Provider errors are classified as permanent, stale, quota or retryable. An explicit FCM UNREGISTERED response retires every linked target on that installation.

An outcome whose provider acceptance was not committed can be attempted again; at-least-once delivery is deliberate. Quotas are committed in a separate transaction before each provider attempt and survive rollback of the target transaction. Installation, target and operation locks serialize transitions and remain held through bounded submission. Current and pending replacement credentials are separate. Android must retain both until it verifies the new receipt. The instance must propagate replacement through a live owner session before sending the new generation.

Unknown IDs return a neutral 404. Retirement of an unknown target before its still-live offer expires does not prove enrollment cannot occur afterward. Keep canceled, unactivated offer cleanup authority until offer expiry, then retry retirement/recovery. Never mark that early 404 as successful final cancellation. Already accepted messages can arrive after retirement; local owner and registration fences remain necessary. Suppress display while enrollment, replacement or local cancellation is pending.

Default limits are 60 attempts per target per hour, 200 per installation per day, and 10 enrollments per approved application/device/direct-peer IP per hour. An installation permits five confirmed and two pending targets. Service capacity is 10,000 installations and 50,000 retained targets. Challenge/offer lifetime is five minutes. Operations and retired targets retain seven days of recovery evidence. Each target admits at most 2,048 retained operation rows; exact recovery allocates no fresh metadata and terminal retirement remains available at that bound. A minute sweep expires abandoned offers and pending replacements, removes expired proof nonces and quota windows, and prunes at most 500 rows per transaction. Idle active users are never expired.

## Source verification and qualification

```sh
bun run push-relay:typecheck
bun run push-relay:test
bun run push-relay:integration
```

The integration runner creates one uniquely named owned PostgreSQL container on a dynamically allocated loopback port, migrates only that dedicated database, and tests a restricted runtime role. Credentials are passed through private files/environment, not process arguments. By default it runs the entrypoint with the host Bun runtime for explicit health/readiness and graceful shutdown, then mounts the same route handler in a Node HTTP fixture for transactional tests. Cleanup removes only that owned container and its private temporary files. It never uses the application's shared integration database.

To qualify an already built relay image without repeating the transactional suite, set `RELAY_TEST_IMAGE` to that local image tag and `RELAY_TEST_SMOKE_ONLY=1`, then run `bun run push-relay:integration`. This Linux-only image fixture uses host networking to reach its owned loopback PostgreSQL port, a dynamically allocated service port, a private environment file, and a read-only private configuration mount. It runs under the nonroot host UID/GID so mode-0600 configuration remains readable in CI and locally. Only its exact owned service/database containers are stopped and removed. The image smoke checks health, database readiness and clean shutdown. Host tests may use a newer Bun than the repository-pinned Bun 1.3.14 image; host results alone do not qualify that shipped runtime.

Injected App Check and FCM tests verify service behavior, cryptographic bindings, real PostgreSQL authority/locking/recovery, copied offers, replay, generation safety and retention bounds. They do not verify a real Firebase project, enrolled Play Integrity/App Check identity, hardware-backed device key, actual background receipt or Doze delivery. Service and instance source integration are implemented and verified. Google Android provider, enrollment and recovery source integration are also implemented; see the [Android guide](../android/README.md#google-flavor-status). Real-provider enrollment, App Check/Play Integrity, signing, physical-device and background/Doze qualification remain required before advertising Google push availability.
