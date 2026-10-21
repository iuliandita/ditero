# Backup And Restore

## Backup

1. Record the running Ditero and Zero versions and deployment configuration, including
   `DITERO_E2E_ENABLED` (defaults to `false`) and attachment storage settings.
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

## Workspace Leave Upgrade

Run the membership-leave cleanup migration before deploying the application that offers
Leave workspace. It adds restricted notification-cleanup policies and triggers so every
member role can leave; existing rows, attachment ciphertext and key envelopes are unchanged.
Keep the usual coordinated database and attachment backup before migrating. Older client versions
continue to work, but only updated clients offer Leave workspace. Application rollback
can retain this additive migration; do not restore an older database over newer membership
changes. Leaving and owner removal both require remaining members to rotate file keys.

## Browser Offline Reload Upgrade

Upgrade the web build to apply sign-out and refusal fencing, public-shell cache matching,
and prompt persistence of accepted edits even during a sync outage with browser connectivity.
Browser identity evidence gains a shared generation marker; Zero stores, server rows and
attachment formats are unchanged; no conversion is required. Keep the coordinated database,
attachment and secret backup described above. Device-only queued edits are not included in server backups: reconnect
and let them sync before clearing browser storage. If the browser warns about unsaved
changes on reload, stay on the page and allow local storage to finish or recover. The warning
remains active after failed account retirement and clears after a successful save and close.

Application rollback does not require a database restore, but older web clients lose these
reload safeguards. Existing native client versions retain their own authentication and lifecycle
behavior. The service worker still caches only public files; API CORS and live authorization
checks are unchanged.
