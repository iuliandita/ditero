# Backup And Restore

## Backup

1. Record the running Ditero and Zero versions and deployment configuration, including
   `DITERO_E2E_ENABLED` (defaults to `false`) and attachment storage settings.
   Quiesce application writes and attachment garbage collection until the database
   and blob snapshots are complete. A blob deleted after the database snapshot
   can otherwise be missing from the restored backup set. Keep maintenance traffic
   isolated; a running process alone does not establish a quiet backup window.
2. Run `pg_dump --format=custom` with a role that can read the entire database.
   For the bundled stack, use its administrator login `postgres`. The app's
   `ditero_migrator` cannot read Zero's CDC/CVR schemas and is not a full backup
   role. For external PostgreSQL, use a superuser or an owner/backup login with explicit
   `USAGE` on all included schemas and `SELECT` on all tables/sequences (including
   Zero's internal schemas). In either case, the role must bypass row security for
   a complete dump, including tables with forced row security. Schema ownership
   alone does not bypass `FORCE ROW LEVEL SECURITY`. Keep this access separate
   from the application runtime login.
3. After the database dump finishes, snapshot the attachment filesystem volume or S3 bucket. Never
   take the blob snapshot first: a restored database row must not point at a blob that was absent
   from the snapshot. See [Attachment Storage](attachment-storage.md).
4. Back up the Zero replica volume only as an optimization; PostgreSQL remains authoritative.
5. Back up field-encryption keys separately from the database. E2E private-key and workspace-key
   envelopes are in PostgreSQL, but users still need an encryption passphrase, recovery code, or
   remembered browser to open them.
6. Encrypt the backup set, record checksums and a shared backup-set identifier, and test restoration
   on an isolated instance.

For bundled Compose, choose a new output filename and run from the repository root:

```sh
(
set -eC
umask 077
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml --profile bundled \
  exec -T upstream-db pg_dump -U postgres -d ditero --format=custom > ditero.dump
)
```

Check the exit status, encrypt the dump and keep service secrets/role definitions
separately. `pg_dump` does not back up cluster logins or replication slots.

## Restore

1. Stop the app and Zero.
2. Prepare a compatible PostgreSQL 15+ server with `wal_level=logical`. Recreate
   separate migration, runtime and Zero logins with the original passwords before
   restoring objects owned by them; grant runtime access without owner or
   `BYPASSRLS` membership. A fresh bundled `upstream-db` initializes these roles
   from the original deployment secrets.
3. Restore the dump using the administrator/restore role, preserving ownership,
   grants and row security. On the isolated bundled target, with app and Zero
   stopped, run:

   ```sh
   docker compose --env-file deploy/docker/.env \
     -f deploy/docker/docker-compose.yml --profile bundled \
     exec -T upstream-db pg_restore -U postgres -d ditero \
     --clean --if-exists --exit-on-error < ditero.dump
   ```
4. Restore the matching attachment snapshot before accepting traffic. Extra unreferenced blobs
   from a newer snapshot are harmless; a database row whose blob is missing is not recoverable.
5. Restore the original deployment configuration, current and fallback field-encryption keys,
   and service secrets. Preserve `DITERO_E2E_ENABLED=true` if attachments were enabled:
   `/api/e2e/*` and `/api/attachments/*` return `404` while disabled. Keep the restored
   account/workspace key envelopes and ciphertext; do not generate replacement keys or
   reenroll accounts to work around missing configuration.
6. Back up and remove only the target's old Zero replica cache.
7. Start Ditero, let migrations finish, and wait for app health before starting
   Zero so it rebuilds from PostgreSQL. Verify health, login, TOTP, JWT issuance, RLS isolation, sync,
   one encrypted integration credential, and one attachment download and decryption.

During an upgrade, startup probes an enabled filesystem attachment directory by creating and
removing a private file. Restore its ownership and write permissions before
starting; a missing directory, `EACCES` or `EROFS` stops startup. No attachment
format migration is required, and older clients remain compatible. Keep the
original `BETTER_AUTH_SECRET` with each backup: startup also checks the stored
JWKS private key. Changing that secret requires [key rotation](key-rotation.md#authentication-secret-rotation),
not a replacement value during restore. A rollback of an authentication-secret
rotation requires reversing the rotation or restoring matching database and
secret backups together.

Never test a restore by pointing it at the production Zero replica or notification channels.
Read [E2E Key Loss](e2e-key-loss.md) before treating a successful infrastructure restore as proof
that encrypted files remain decryptable.

## Kubernetes logical backup and restore

The same logical path applies to Helm, bare Kustomize and CloudNativePG. Record
an explicit context and namespace for every command. Provision a fresh namespace,
original role passwords and service secrets, verified database connections, and
empty application/Zero claims for the target. Use an administrator connection
inside the database pod or an approved backup client; the application runtime
connection cannot produce a complete backup.

For a database pod with local administrator access, use the following pattern,
substituting the recorded context, namespace and database pod:

```sh
(
set -eC
umask 077
kubectl --context CONTEXT --namespace SOURCE exec DATABASE_POD -- \
  pg_dump -U postgres -d ditero --format=custom > database.dump
)
```

For CloudNativePG, this uses the database pod's local Unix socket; it does not
require enabling remote access for the reserved `postgres` login. The operator
and managed role passwords must reconcile before restoring. A logical dump does
not contain cluster logins, replication slots, operator configuration or Secrets.
A maintained backup plugin is required for continuous WAL archival/PITR; it is
not required for this logical backup path.

After the dump, snapshot the attachment claim. For a quiet qualification stack,
stop Zero first and block user writes for the entire database/blob backup window.
The running app can supply the archive through `kubectl exec` and `tar`; an
operator may instead use its CSI snapshot mechanism. Retain and encrypt the
matching configuration and original secrets separately. Decrypt the recovery
archive and verify every recorded checksum before restoring.

On the fresh target, keep app and Zero replicas at zero while restoring:

```sh
kubectl --context CONTEXT --namespace TARGET exec -i DATABASE_POD -- \
  pg_restore -U postgres -d ditero --clean --if-exists --exit-on-error < database.dump
```

Restore the attachment archive into the app claim using a temporary pod with
the app's UID/GID 1000, `fsGroup: 1000`, and explicit resource requests/limits.
Wait for that writer to exit before starting the app. Keep the Zero claim empty.
Start only the app, wait for migrations and `/health`, then start Zero. Plain
Kustomize applies both Deployments together; stage its replicas explicitly on
first installation, migration and recovery. Helm's current release-revision
health gate handles app-before-Zero startup, including upgrades from older charts.

Before replacing or removing a failed pod, capture its current and previous
logs, events and description. From a source checkout, the bounded read-only
collector saves private files and records truncation, timeouts and command errors:

```sh
node tests/container/kubernetes-diagnostics.mjs CONTEXT NAMESPACE NEW_PRIVATE_DIRECTORY
```

A missing previous log is recorded as an error; it does not prove that the
container never failed. Keep the first failing capture and inspect `capture.json`
before cleanup. Readiness alone is insufficient: sign in as the original user,
unlock the retained keys, decrypt the original attachment, and confirm a mutation
reaches PostgreSQL and a fresh sync client. Retain the source until these checks
pass. An image rollback does not reverse migrations; restore a matching backup
set into an isolated target when database rollback is required. Existing clients
keep the same data and attachment formats.

## Workspace Leave Upgrade

Run the membership-leave cleanup migration before deploying the application that offers
Leave workspace. It adds restricted notification-cleanup policies and triggers so every
member role can leave; existing rows, attachment ciphertext and key envelopes are unchanged.
Keep the usual coordinated database and attachment backup before migrating. Older client versions
continue to work, but only updated clients offer Leave workspace. Application rollback
can retain this additive migration; do not restore an older database over newer membership
changes. Leaving and owner removal both require remaining members to rotate file keys.
