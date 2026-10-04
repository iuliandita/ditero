# Ditero Helm chart

This chart packages the server for Kubernetes. It runs
the web/API image and its matching Zero sync image, with an external PostgreSQL
database. The chart version is `0.0.1-alpha.2`; it is a prerelease.

## Prerequisites

- A namespace, a storage class supporting `fsGroup`, and two persistent volumes.
- PostgreSQL configured for logical replication (`wal_level=logical`, sufficient
  replication slots and WAL senders), with direct connections for Zero. A
  transaction-pooling proxy is unsuitable for Zero's replication connection.
- Three separate database logins: migration owner, restricted application runtime,
  and Zero with its required replication/schema privileges. Follow the
  [database role runbook](../../../docs/runbooks/database-roles.md), including the
  `zero_0` schema grants and default privileges for both application roles.
- An existing Secret in the release namespace, provisioned through your secret
  manager or another secure mechanism. This chart creates no Secrets.

The Secret must contain these keys:

| Key | Used by | Value |
| --- | --- | --- |
| `DATABASE_URL` | Application | Runtime-role PostgreSQL DSN |
| `DATABASE_MIGRATION_URL` | Application entrypoint | Migration-owner PostgreSQL DSN |
| `BETTER_AUTH_SECRET` | Application | Stable random authentication secret, at least 32 characters |
| `DITERO_ENCRYPTION_KEY` | Application | Base64-encoded 32-byte encryption key |
| `ZERO_UPSTREAM_DB` | Zero | Direct Zero-role PostgreSQL DSN |
| `ZERO_ADMIN_PASSWORD` | Zero | Strong random administration password |

Only each component's required keys are mounted in its container. The entrypoints
read the files through their supported `*_FILE` variables. Zero defaults its CVR
and change databases to `ZERO_UPSTREAM_DB`; they share the upstream database in
this initial chart. Enable database TLS in each DSN according to your provider.
Follow the [database TLS guide](https://github.com/iuliandita/ditero/blob/develop/docs/runbooks/database-tls.md) for private
CA mounts and Zero's distinct trust configuration.

The runtime role must not own application tables, inherit the migration owner,
be a superuser, or have `BYPASSRLS`. Production startup verifies that restriction.
The application entrypoint applies migrations before starting; take a database
backup before upgrading. The chart does not provision or migrate database roles.

## Install

Create a separate `values-production.yaml`. Keep credentials in the existing
Secret, and set both browser-visible URLs:

```yaml
existingSecret: ditero-secrets
app:
  publicUrl: https://tasks.example.com
  publicZeroUrl: https://sync.example.com
  ingress:
    enabled: true
    className: traefik
    host: tasks.example.com
    tlsSecretName: tasks-tls
zero:
  ingress:
    enabled: true
    className: traefik
    host: sync.example.com
    tlsSecretName: sync-tls
```

Use a maintained Ingress controller with WebSocket support. The Zero host must
route `/` without stripping or rewriting its path. Configure WebSocket idle
timeouts and proxy upload limits on your controller as needed. Both URLs must be
reachable by users' browsers; a Kubernetes service DNS name cannot serve as
`app.publicZeroUrl`. TLS is required for normal remote browser use.

```sh
kubectl config current-context
helm lint deploy/helm/ditero --strict -f values-production.yaml
helm template household deploy/helm/ditero \
  --namespace ditero -f values-production.yaml
helm upgrade --install household deploy/helm/ditero \
  --namespace ditero --create-namespace \
  -f values-production.yaml --wait --timeout 15m
```

With Ingress disabled, the chart exposes ClusterIP services. The defaults use
`http://localhost:3000` and `http://localhost:4848`; port-forward both services
in separate terminals for local testing:

```sh
kubectl --namespace ditero port-forward service/household-ditero-app 3000:3000
kubectl --namespace ditero port-forward service/household-ditero-zero 4848:4848
```

Images default to `ghcr.io/iuliandita/ditero:0.0.1-alpha.2` and
`ghcr.io/iuliandita/ditero:0.0.1-alpha.2-zero`. Change either repository to
`docker.io/iuliandita/ditero` to use Docker Hub. Set `app.image.digest` and
`zero.image.digest` to verified `sha256:...` values to pin immutable images;
digests take precedence over tags. Always upgrade the application and Zero pair
together.

## Configuration and operations

The commented [`values.yaml`](values.yaml) describes the supported options.
The chart deliberately runs one application replica and one Zero replica, with
Recreate updates. Filesystem attachments and Zero's SQLite replica are local
state; overlapping pods must not write the same volume. Upgrades interrupt
service. This initial chart does not provide high availability.

Both claims default to 10 GiB and `ReadWriteOnce`. Set
`app.persistence.existingClaim` or `zero.persistence.existingClaim` to reuse a
claim; the chart then does not create it. Claims and Secrets must share the
release namespace. An empty `storageClass` uses the cluster default; `"-"`
requests no class. The application runs as UID/GID 1000, and Zero also runs as
UID/GID 1000. Existing volumes must permit that identity or group to write.
The chart uses `fsGroup: 1000`, disables service-account token mounts, and drops
all container capabilities. Root filesystems are read-only, with a bounded
writable `/tmp` and persistent data mounts.

Default resources are starting estimates, not measured capacity guarantees.
Monitor memory and storage usage and adjust requests and limits for your data.
Startup probes allow up to ten minutes for migrations and initial replication;
readiness/liveness use the real `/health` and `/keepalive` endpoints. The
application health endpoint proves the HTTP process is serving; it does not
continuously test every database, sync, or notification dependency.

Use `app.extraEnv` and `zero.extraEnv` for additional supported configuration.
Use `valueFrom.secretKeyRef` for sensitive settings rather than literal values.
Do not repeat chart-managed variables. If customizing Zero's app/shard identity,
set the matching application `DITERO_ZERO_SHARD_SCHEMA` and database grants.
Proxy trust defaults to none; explicitly set `DITERO_TRUSTED_PROXIES` only to
your controller's actual addresses. Restart both deployments after changing
Secret values: entrypoints load secrets at startup.

Apply your cluster's NetworkPolicies to permit browser ingress, app/Zero
callbacks, DNS, PostgreSQL, and any enabled notification providers. This chart
does not impose a policy because those destination addresses and controllers
are deployment-specific. No Kubernetes API access or RBAC is needed by either
service.

Back up PostgreSQL, the attachment claim, and the authentication/encryption
Secrets. Preserve the Zero claim for normal restarts; it contains the replica
cache and can be rebuilt from PostgreSQL if necessary. Test restore before
relying on backups. Chart-created PVCs carry `helm.sh/resource-policy: keep` and
remain after uninstall. To reuse retained data, set the corresponding
`existingClaim` before reinstalling. Delete retained claims manually only after
backup and an explicit decision to discard that data. Use a suitable volume
reclaim policy as an additional safeguard. A Helm rollback does not undo database
migrations.
