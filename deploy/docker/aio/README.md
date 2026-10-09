# Experimental one-image deployment bundle

This optional bundle contains PostgreSQL18, Ditero and Zero in one image and runs
four separate containers: PostgreSQL1001, migration1000, API1000 and Zero1002.
It replaces the earlier single-container supervisor candidate. Existing ordinary
Compose and Helm deployments are unchanged. This source candidate is not published
or runtime-qualified; earlier single-container results do not qualify this topology.

## Build and image selection

Build from the repository root with `deploy/docker/Dockerfile.all-in-one`.
`ZERO_RUNTIME_IMAGE` must be a qualified Alpine Ditero Zero runtime pinned by
immutable digest; arbitrary upstream Zero images are not interchangeable. The
Bun builder and architecture package artifacts retain their existing pins.
The final image defaults to API UID1000. No runtime role switches UID, adds
capabilities or repairs volume ownership. No supervisor or Docker socket runs
inside the role containers. The bundle installs no supervisor.

```sh
docker build --file deploy/docker/Dockerfile.all-in-one \
  --build-arg ZERO_RUNTIME_IMAGE="$ZERO_RUNTIME_IMAGE" \
  --tag ditero-bundle:experimental .
```

After independently qualifying and resolving that image, export `DITERO_AIO_IMAGE`
to its immutable `registry/image@sha256:...` identity. All four roles use that
same identity. The host wrapper refuses mutable tags and disables pulls/builds.

## Experimental publication candidate

The optional `Experimental AIO bundle` workflow prepares separate amd64 and arm64
images. Publication requires a manual dispatch whose full 40-character commit SHA
matches the dispatch ref, belongs to develop, and has passing latest same-commit
CI, Security, Android, Desktop and release-packaging push runs. PR validation has
read-only permissions and cannot publish images.

Each platform is scanned before push, then signed and given a digest-specific
SPDX SBOM attestation in GHCR and Docker Hub. Build provenance is attested in GHCR,
matching the ordinary release publication pattern; identical content digests bind
the Docker Hub copies. The multiarch index is also signed in both registries and
has GHCR provenance. The candidate name includes the full source SHA, workflow run
ID and attempt. It never moves standard image tags or creates release assets.
A failed partial publication can leave experimental platform images; rerun all
jobs for a new candidate rather than mixing evidence from different attempts.

The workflow's 30-day bundle artifact contains the unchanged wrapper and Compose
files, their guides, source identity, immutable image inventory, platform SBOMs
and SHA256 checksums. Verify the artifact checksums and registry signatures,
provenance and SBOM attestations using the exact workflow identity before use.
Extract into a private directory, verify `SHA256SUMS` there, and select the
inventory's `registry/image@sha256:...` index identity. Preload the selected image;
the wrapper itself never pulls or builds. The extracted startup command is
`sh deploy/docker/aio/run-bundle.sh`.

This workflow and package are source candidates until an actual publication is
verified. Publication alone does not establish wrapper-only TERM/HUP reaping,
sustained health failure propagation, arm64 runtime support or backup/restore.
Those require separate qualification against the exact published digest.

## Private role inputs

Prepare four separate private host directories, owned by the corresponding
numeric role UID with mode0700. Each listed credential is a nonsymlink regular
file owned by that UID with mode0600. Standalone Compose does not remap bind
mount ownership. The parent and file are checked before reading. A root-only
master secret directory is not mounted into any service.

| Directory variable | Owner | Required filenames |
| --- | --- | --- |
| AIO_POSTGRES_SECRETS | 1001 | POSTGRES_PASSWORD, DITERO_MIGRATION_DB_PASSWORD, DITERO_RUNTIME_DB_PASSWORD, ZERO_DATABASE_PASSWORD |
| AIO_MIGRATE_SECRETS | 1000 | DITERO_MIGRATION_DB_PASSWORD |
| AIO_API_SECRETS | 1000 | DITERO_RUNTIME_DB_PASSWORD, BETTER_AUTH_SECRET, DITERO_ENCRYPTION_KEY |
| AIO_ZERO_SECRETS | 1002 | ZERO_DATABASE_PASSWORD, ZERO_ADMIN_PASSWORD |

The four database passwords must differ. Copies of a role password must contain
the same original bytes. The encryption key is canonical base64 of exactly32
bytes. Keep original passwords/authentication/encryption keys for retained data;
startup is never authority to replace missing recovery material. File parsing
removes trailing line terminators only, preserves spaces and refuses internal
line breaks, NUL, conflicts and unsupported configuration namespaces.

Set the directory variables and `BETTER_AUTH_URL`/`PUBLIC_ZERO_URL` in the host
environment or a private Compose `.env` beside this guide. These values contain
paths and public origins; credential values must stay in their role files.
Optional API settings may be added explicitly to the API service environment;
do not inject a shared environment file into every role. Remote access requires
operator-managed HTTPS. The shipped port bindings remain loopback-only.

## Configuration boundary

The wrapper reads `DITERO_AIO_IMAGE` and `DITERO_AIO_PROJECT`; Compose also accepts
`AIO_APP_PORT` and `AIO_ZERO_PORT` for loopback bindings. Its credential paths are
`POSTGRES_PASSWORD_FILE`, `DITERO_MIGRATION_DB_PASSWORD_FILE`,
`DITERO_RUNTIME_DB_PASSWORD_FILE`, `ZERO_DATABASE_PASSWORD_FILE`,
`ZERO_ADMIN_PASSWORD_FILE`, `BETTER_AUTH_SECRET_FILE` and
`DITERO_ENCRYPTION_KEY_FILE`. Do not override generated `DATABASE_URL` values.
`API_PORT=3000`, `NODE_ENV=production` and `DITERO_ZERO_SHARD_SCHEMA=zero_0` are fixed.
Build metadata uses `DITERO_GIT_SHA` and `DITERO_CHANNEL`; neither configures runtime.

Optional API settings retain the meanings in the [deployment settings guide](../../../docs/runbooks/deployment-settings.md).
Add them only to the API environment in an operator-owned Compose override:

- Identity/discovery: `DITERO_REGISTRATION_MODE`, `DITERO_MEMBER_INVITES`,
  `DITERO_DISCOVERY`, `DITERO_PUBLIC_URL`, `DITERO_PASSKEY_ORIGIN`,
  `DITERO_PASSKEY_RP_ID`, `DITERO_TRUSTED_PROXIES`, `TRUSTED_ORIGINS`,
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- Attachments: `DITERO_ATTACHMENT_STORAGE_DRIVER`, `DITERO_ATTACHMENT_FS_PATH`,
  `DITERO_ATTACHMENT_QUOTA_BYTES`, `DITERO_ATTACHMENT_RETENTION_MS`,
  `DITERO_ATTACHMENT_SWEEP_BATCH_SIZE`, `DITERO_ATTACHMENT_SWEEP_MS`,
  `DITERO_ATTACHMENT_S3_BUCKET`, `DITERO_ATTACHMENT_S3_REGION`,
  `DITERO_ATTACHMENT_S3_ENDPOINT`, `DITERO_ATTACHMENT_S3_ACCESS_KEY_ID` and
  `DITERO_ATTACHMENT_S3_SECRET_ACCESS_KEY`.
- Mail/push: `DITERO_SMTP_HOST`, `DITERO_SMTP_PORT`, `DITERO_SMTP_SECURE`,
  `DITERO_SMTP_ALLOW_INSECURE`, `DITERO_SMTP_FROM`, `DITERO_SMTP_USER`,
  `DITERO_SMTP_PASSWORD`, `DITERO_NATIVE_PUSH_RELAY_ORIGIN`,
  `DITERO_NATIVE_PUSH_VAPID_PUBLIC_KEY`, `DITERO_NATIVE_PUSH_VAPID_PRIVATE_KEY`,
  `DITERO_NATIVE_PUSH_VAPID_SUBJECT`, `DITERO_TELEGRAM_MODE`,
  `DITERO_TELEGRAM_MAX_BOTS`, `DITERO_TELEGRAM_POLL_TIMEOUT_SEC` and
  `DITERO_TELEGRAM_WEBHOOK_SECRET`.
- Background work: `DITERO_BACKGROUND_JOBS`, `DITERO_REPLICA_ID`,
  `DITERO_MAX_QUEUED_PER_USER`, `DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS`,
  `DITERO_NOTIFY_DEADLINE_MS`, `DITERO_OUTBOX_RETENTION_MS`,
  `DITERO_OVERDUE_SWEEP_MS`, `DITERO_PRUNE_BATCH_SIZE`,
  `DITERO_PRUNE_CADENCE_TICKS`, `DITERO_SCHEDULER_GRACE_MS`,
  `DITERO_SCHEDULER_LATE_THRESHOLD_MS`, `DITERO_SCHEDULER_TICK_MS`,
  `DITERO_WORKER_BATCH_SIZE`, `DITERO_WORKER_CONCURRENCY`,
  `DITERO_WORKER_LEASE_MS` and `DITERO_WORKER_TICK_MS`.

Key rotation accepts `DITERO_ENCRYPTION_KEY_NEXT`. That key, `GOOGLE_CLIENT_SECRET`
and both S3 credentials also accept their `_FILE` forms in the API's private
directory. SMTP, Telegram and VAPID private secrets currently accept plain API
environment values only; keep any override containing them private. Do not pass
these inputs to sibling roles. `SERVE_STATIC_DIR` retains its image default.
Unsupported namespaces and client/test inputs such as `DITERO_E2E`, `DITERO_TEST_*`,
`DITERO_URL` and `DITERO_TOKEN` fail closed.

## Startup, ownership and lifecycle

```sh
sh deploy/docker/aio/run-bundle.sh
```

Use a dedicated `DITERO_AIO_PROJECT` name (default `ditero-aio`); the wrapper owns
that project's foreground lifecycle. Do not share it with another deployment.
PostgreSQL initializes through a temporary private socket server and stops it
before admitting the steady server. Migration uses its existing session advisory
lock and must finish before API startup. API health and unauthorized query/mutate
probes gate Zero. PostgreSQL has no published port. API has an outbound network;
PostgreSQL, migration and Zero share only the internal backend network.

Every role uses a read-only root, no-new-privileges, all capabilities dropped,
private role-owned tmpfs and only its own credentials/data mounts. The three named
volumes retain PostgreSQL, replica and attachments. New named volumes rely on
runtime copy-up of build-time owned mode0700 mount points. Wrong owner/mode,
partial initialization or incompatible PostgreSQL data fails closed, including
an empty wrong-owner mount. No recursive chown, automatic repair/reset, or volume
deletion exists. Bind mounts/PVCs require separately reviewed operator ownership
setup before startup; the bundle does not hide a privileged initialization step.

Unexpected essential-child exit, including exit0, becomes a failure. Each steady
role also probes its own health every five seconds, with a120second startup grace
and a25second per-probe deadline. Three consecutive failures after first health
success or grace expiry stop the role with failure; a successful probe resets the
count. This bounds sustained health failure as well as process death. The host
foreground Compose controller stops siblings on failure; successful migration is
an expected oneshot exit. The wrapper records its asynchronous Compose child and waits with the shell
builtin, so signals sent only to the wrapper trigger scoped stop and child reaping.
Normal interrupt/termination stops the project while
retaining volumes. Detached Compose alone does not preserve this lifecycle
contract. A host service manager must keep the wrapper alive. Forced controller
loss, actual signal/reaping behavior and credential isolation still need runtime
qualification; they are not established by source configuration.

The database is PostgreSQL18 with SCRAM/logical WAL and separate admin, migrator,
runtime and Zero roles. The runtime is nonsuperuser/NOBYPASSRLS; Zero retains its
dedicated database superuser for replication/schema lifecycle. Database/API
addresses now use internal service DNS rather than the old loopback assumption.
The backend network is a deployment trust boundary, not TLS qualification.

## Qualification limits

Required gates include unchanged security scans; exact final-image process/health/
exec UIDs and zero capability sets; fresh named-volume copy-up; private-file and
sibling-secret denial; current migrations and combined readiness; retained restart
with original data/credentials; startup/essential-child/guardian/controller-loss
failures; first-cause preservation; graceful stop/reaping and log leak checks.
arm64 and encrypted backup/restore remain separate gates. No complete support,
publication or fresh runtime pass is claimed by this source redesign.
