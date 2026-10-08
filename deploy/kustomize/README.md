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
| `BETTER_AUTH_SECRET` | App | Stable random authentication secret, at least 32 characters |
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
- name: ghcr.io/iuliandita/ditero
  newName: docker.io/iuliandita/ditero
  newTag: 0.0.1-alpha.11
configMapGenerator:
- name: ditero-app-config
  behavior: merge
  literals:
  - BETTER_AUTH_URL=https://tasks.example.com
  - PUBLIC_ZERO_URL=https://sync.example.com
  - DITERO_REGISTRATION_MODE=closed
patches:
- target:
    kind: Deployment
    name: ditero-zero
  patch: |-
    - op: replace
      path: /spec/template/spec/containers/0/image
      value: docker.io/iuliandita/ditero:0.0.1-alpha.11-zero
```

Always upgrade the app/Zero image pair together. Pin both images to verified
immutable digests for production. Since both use the same repository with
different tags, a repository-wide image override also rewrites the Zero tag;
set the Zero image explicitly as shown when overriding the pair. Kustomize
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

## Operations and boundaries

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
Secrets together. Preserve the Zero claim for normal restarts; its replica cache
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
