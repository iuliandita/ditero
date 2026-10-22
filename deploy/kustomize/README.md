# Ditero Kustomize base

This base packages one web/API Deployment and one matching Zero Deployment for
Kubernetes, with two ClusterIP Services and two persistent volume claims. It uses
an external PostgreSQL 18 database and an existing Secret. It does not deploy a
database, CloudNativePG, an external routing controller, or a TLS issuer.

The optional [CloudNativePG overlay](cnpg/README.md) adds a separately managed
single-instance PostgreSQL cluster. Its credential, privilege and recovery
requirements are explicit; the external-database base remains unchanged.

The published image pair is a prerelease. The base is locally renderable; live
cluster installation, CSI behavior, upgrades, backups, and restore still require
operator qualification. It does not provide high availability.

## Prerequisites

Prepare a namespace with a storage class that supports `ReadWriteOnce` claims and
`fsGroup: 1000`. The base creates namespace `ditero` with Pod Security Admission
`enforce`, `audit`, and `warn` set to `restricted`. Both containers run as UID/GID
1000 with read-only root filesystems, dropped capabilities, no privilege
escalation, and no service-account token mount. Existing volumes must permit that
identity or group to write. Each claim requests 10 GiB; set a storage class and
capacity suitable for your deployment in an overlay.

PostgreSQL must support logical replication, enough replication slots and WAL
senders, and direct connections for Zero. Transaction-pooling proxies are not
suitable for Zero's replication connection. Use separate migration-owner,
restricted runtime, and Zero replication/schema logins. Follow the
[database roles runbook](../../docs/runbooks/database-roles.md), including the
`zero_0` schema and scoped default privileges. Runtime must not own application
tables, inherit the migration owner, be a superuser, or have `BYPASSRLS`.

Provision an existing Secret named `ditero-secrets` in the chosen namespace using
your secret manager or protected delivery mechanism. The base creates no Secret
and never includes credential values in configuration. Supply all six keys:

| Key | Component | Value |
| --- | --- | --- |
| `DATABASE_URL` | App | Restricted runtime-role PostgreSQL DSN |
| `DATABASE_MIGRATION_URL` | App entrypoint | Migration-owner PostgreSQL DSN |
| `BETTER_AUTH_SECRET` | App | Stable random authentication secret, at least 32 characters; change only through the [rotation procedure](../../docs/runbooks/key-rotation.md#authentication-secret-rotation) |
| `DITERO_ENCRYPTION_KEY` | App | Base64-encoded 32-byte encryption key |
| `ZERO_UPSTREAM_DB` | Zero | Direct Zero-role PostgreSQL DSN |
| `ZERO_ADMIN_PASSWORD` | Zero | Strong random administration password |

Only the app's four keys and Zero's two keys are projected into their respective
containers, read through `*_FILE` variables. Enable database TLS in the DSNs
according to your database provider. Follow the [database TLS guide](../../docs/runbooks/database-tls.md)
for private CA mounts and Zero's distinct trust configuration. Zero's CVR and change databases default to
its upstream database. Entry points load secrets at startup; restart both
Deployments after changing Secret values. Preserve authentication and encryption
keys when upgrading or recovering existing data.

## Configure an overlay

Keep deployment-specific configuration in an overlay. For example, place an
`overlay` directory beside `base` and use this `kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- ../base
namespace: household
namePrefix: home-
images:
- name: ghcr.io/iuliandita/ditero:0.1.0-beta.1
  newName: docker.io/iuliandita/ditero
  newTag: 0.1.0-beta.1
- name: ghcr.io/iuliandita/ditero:0.1.0-beta.1-zero
  newName: docker.io/iuliandita/ditero
  newTag: 0.1.0-beta.1-zero
configMapGenerator:
- name: ditero-app-config
  behavior: merge
  literals:
  - BETTER_AUTH_URL=https://tasks.example.com
  - PUBLIC_ZERO_URL=https://sync.example.com
  - DITERO_REGISTRATION_MODE=closed
```

Always upgrade the app/Zero image pair together. Pin both images to verified
immutable digests for production. The base pins the pair as
`ghcr.io/iuliandita/ditero:<version>` and `<version>-zero`, and an `images` entry
that includes the tag matches only that reference. Use one entry per image, as
shown, with the tags of the base you build on. The Zero container and its
`wait-for-app` init container share a reference, so one entry rewrites both. A
name-only entry would also rewrite the Zero tag. Kustomize
rewrites generated ConfigMap references and internal app Service references when
renaming resources. The external Secret remains named `ditero-secrets`; patch the
projected Secret references if your operator uses another name.

The default browser URLs are `http://localhost:3000` and
`http://localhost:4848`, suitable only for local access with both Services
forwarded. Remote users need reachable HTTPS origins for both URLs; cluster
Service names cannot be browser-visible sync origins. Configure your maintained
routing controller and TLS separately, such as Gateway API routes where
supported. Route the app to port 3000 and Zero to port 4848; Zero needs WebSockets
and its full path preserved without stripping or rewriting. Set controller
WebSocket timeouts and upload limits for your use. Configure
`DITERO_TRUSTED_PROXIES` only for your actual controller addresses if proxy trust
is required.

Encrypted attachments are disabled by default; `/api/e2e/*` and
`/api/attachments/*` return `404` while disabled. To opt in, add
`DITERO_E2E_ENABLED=true` to the existing merged `ditero-app-config` generator's
`literals`, preserving its other entries:

```yaml
configMapGenerator:
- name: ditero-app-config
  behavior: merge
  literals:
  - DITERO_E2E_ENABLED=true
```

Browser encryption requires HTTPS or a browser-secure loopback origin with Web
Crypto available, plus account key enrollment and a workspace key grant. Plain
HTTP on a LAN is insufficient. See the [attachment guide](../../README.md#encrypted-attachments).

## Render and deploy

Render locally before any cluster change:

```sh
kubectl kustomize deploy/kustomize/base
kubectl kustomize deploy/kustomize/overlay
bun run tests/kustomize/render.ts
```

The render test also accepts a base directory argument, so an extracted deployment
archive can be checked without using the checkout's base manifests. Inspect the
rendered namespace, image pair, URLs, Secret and PVC references. Before applying,
verify your kube context and namespace, run server-side dry-run and diff against
that target, and obtain your normal deployment approval. The base can be applied
with `kubectl apply -k` by the authorized operator after those checks.

Zero must not start while application migrations run, because Zero's DDL event
triggers would otherwise see a partially migrated schema. The Zero Deployment has
a `wait-for-app` init container that runs the Zero image and polls the app
`/health` until the reported `revision` equals the init container's own
`DITERO_GIT_SHA`. Both published images carry their build commit in that variable,
and the app answers 200 only after its migrations finish. The old app pod, or a new
one still migrating, reports another revision, so Zero starts only after the new
app is migrated and healthy. Because the commit comes from the images, any `images`
override keeps the gate correct without extra overlay fields. A pair built from
different commits never opens the gate. Apply the base or overlay once; no staged
replicas are needed.

The gate fails closed when the Zero image's `DITERO_GIT_SHA` is empty or missing,
or when the app reports a missing, empty or different revision. It never falls
back to image tags or replica identifiers, which can stay unchanged across an
upgrade. Build local app and Zero images from the same commit with
`--build-arg DITERO_GIT_SHA=<full-commit-sha>`; unlabeled images remain waiting.
Do not override `DITERO_GIT_SHA` in deployment configuration. If the gate stays
blocked, verify both images' baked commit and the app's migration/startup logs,
then deploy the matching image pair. The app starts independently of Zero, so a
matching healthy app releases the gate without a circular startup dependency.

Operators upgrading from `0.0.1-alpha.12` or earlier, or from a render without the
init container, should remove any manual zero-replica hold patch; applying it
with the gate present is harmless but blocks Zero. Use explicit context and
namespace arguments for every operation. The init container uses the Zero image,
`node`, and no Kubernetes API access; a Zero image without `node` cannot run it.

## Operations and boundaries

Zero uses `ZERO_AUTH_REVALIDATE_INTERVAL_SECONDS=30`. After sign-out or session
revocation, an open subscription can receive updates until its next `/query`
revalidation, plus request/scheduling latency. Deploy this configuration update to
shorten the former five-minute default; no data migration is needed. See
[session revocation](../../docs/security.md#authentication).

Both Deployments use one replica and `Recreate` updates. The app's filesystem
attachment store and Zero's SQLite replica are persistent local state; overlapping
pods must not write these claims. Updates interrupt service. Do not increase
replicas or change to rolling updates without a separately qualified storage and
runtime design. Startup probes allow up to ten minutes; app probes use `/health`
and Zero probes use `/keepalive`. HTTP process health does not establish that
every database, sync, or notification dependency is healthy.

Resource requests and limits are starting estimates, not capacity guarantees.
Each container requests 64 MiB of ephemeral storage with a 512 MiB limit; the
writable `/tmp` is bounded at 256 MiB. Monitor memory, ephemeral storage,
attachment storage, PostgreSQL and replication behavior. Configure retention and
storage expansion with your CSI provider, and qualify ownership, mount, restart,
and upgrade behavior on the real cluster.

The base provides no NetworkPolicy. Apply policies appropriate to your CNI and
routing controller that allow browser ingress, app/Zero callbacks, DNS,
PostgreSQL, and enabled outbound notification providers. Verify those policies
with actual traffic; local render success does not prove egress restrictions,
TLS, CSI compatibility, runtime readiness, or restore. Neither container needs
Kubernetes API permissions.

Back up PostgreSQL, the attachment claim, and the authentication/encryption
Secrets together using the [logical recovery procedure](../../docs/runbooks/backup-restore.md#kubernetes-logical-backup-and-restore).
On first install, upgrade and restore, the Zero init container holds Zero until
the new app has finished migrations and is healthy. For restore, keep both
Deployments at zero replicas until the database and attachment data are restored.
Preserve the Zero claim for normal
restarts; its replica cache
can be rebuilt from PostgreSQL when necessary. Test recovery in an isolated
environment before relying on backups. An image rollback does not undo database
migrations; the app entrypoint applies migrations before starting.

Unlike Helm's retained-claim annotation, plain Kustomize does not protect PVCs
from deletion. `kubectl delete -k` includes both PVCs and the namespace resource;
removing a namespace can delete every namespaced resource, and the volume reclaim
policy can destroy data. Do not use either operation as ordinary uninstall or
cleanup. Preserve claims, namespaces and Secrets unless backup and an explicit
decision authorize discarding their data. Manage PVC retention and reclaim
policy through your storage/GitOps operator before enabling pruning.
