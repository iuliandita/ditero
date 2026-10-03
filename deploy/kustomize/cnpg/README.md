# CloudNativePG deployment

This overlay adds a PostgreSQL 18 cluster to the app/Zero Kustomize base. It
targets CloudNativePG 1.30.1, installed separately by the operator. It creates no
credentials and makes no high-availability or live storage qualification claim.
The database uses one instance; the app and Zero retain singleton Recreate
updates and their existing persistent claims.

## Credentials and privileges

Before initialization, provision three existing `kubernetes.io/basic-auth`
Secrets with `username` and `password` keys:

| Secret | Username | Purpose |
| --- | --- | --- |
| `ditero-db-migrator` | `ditero_migrator` | Database/schema owner, application migrations |
| `ditero-db-runtime` | `ditero_runtime` | Restricted application traffic |
| `ditero-db-zero` | `ditero_zero` | Zero replication and schema detection |

Label each Secret `cnpg.io/reload: "true"` for password reconciliation. Keep
credentials in your secret manager. Bootstrap creates runtime and Zero roles
without login; the operator reconciles their login/passwords after bootstrap.
The runtime role has no ownership, owner membership, superuser or RLS bypass.
Its default privileges cover application tables and the Zero shard only.

The dedicated Zero login is a database superuser. PostgreSQL requires this for
Zero's schema publications and event triggers; the existing bundled Compose
deployment also connects Zero with administrative database privileges. Treat
the Zero credential and process as database administration. Do not reuse this
cluster for unrelated applications. The reserved `postgres` login remains
disabled for remote access through `enableSuperuserAccess: false`; that setting
does not restrict the separate Zero login. A non-superuser Zero deployment
requires a separately qualified publication/schema-change workflow.

Also provision the base's existing `ditero-secrets` Secret. Use the matching
passwords above for its runtime, migration and Zero DSNs. Connect directly to
the cluster's read/write Service, `ditero-db-rw.ditero.svc`, port 5432, database
`ditero`. Enable verified TLS using the operator's server CA and your client
configuration. Neither transaction pooling nor a read-only Service is suitable
for the upstream replication connection. Retain authentication and encryption
secrets when restoring data.

## Configure and render

Render without contacting a cluster:

```sh
kubectl kustomize deploy/kustomize/cnpg
```

The PostgreSQL image is pinned by version and immutable multi-platform digest.
Set storage class, storage capacity, resources, public HTTPS origins and routing
in an operator overlay, following the [base guide](../README.md). The database
starts with 10 GiB, CPU request 250m and memory request 256 MiB; these are
starting values, not capacity guarantees. The operator owns database pod
security, probes, storage and service accounts. Qualify its generated pods
against the namespace's restricted Pod Security policy on your target cluster.

Kustomize rewrites the bootstrap ConfigMap reference. A `namePrefix` also changes
the Cluster and its generated Service name; update the external DSNs accordingly.
It does not rename PostgreSQL database or role names inside SQL. The existing
credential Secrets retain their names unless explicitly patched. Bootstrap SQL
only runs when creating a new database; changing its ConfigMap is not a migration
or privilege reconciliation strategy for an existing cluster.

Verify context, server-side dry-run and diff before an authorized install. Wait
for bootstrap and all managed roles to reconcile before starting application
traffic. Verify actual runtime/migration/Zero connections, logical replication,
shard grants and RLS isolation. Local rendering cannot establish these gates.

## Recovery and retention

Configure a maintained CloudNativePG backup plugin and object-store credentials
through your operator configuration. This overlay does not install a backup
plugin or provide a working archive destination. A PostgreSQL PVC is not a
backup. Test database, encrypted attachment and secret restoration as one backup
set following the public [backup runbook](https://github.com/iuliandita/ditero/blob/develop/docs/runbooks/backup-restore.md).

Do not delete or prune the overlay, namespace, Cluster or PVCs as ordinary
cleanup. The operator can remove database storage when a Cluster is deleted.
Establish retention and recovery policy before enabling GitOps pruning. Live
install, CSI ownership, restart, upgrade, backup/restore and failover remain
operator qualification gates.

References: [bootstrap](https://cloudnative-pg.io/docs/1.30/bootstrap/),
[managed roles](https://cloudnative-pg.io/docs/1.30/declarative_role_management/),
[Zero PostgreSQL requirements](https://zero.rocicorp.dev/docs/connecting-to-postgres).
