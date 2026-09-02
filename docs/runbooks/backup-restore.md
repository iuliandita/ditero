# Backup And Restore

## Backup

1. Record the running Ditero and Zero versions.
2. Run `pg_dump --format=custom` against the migration-owner or backup role.
3. After the database dump finishes, snapshot the attachment filesystem volume or S3 bucket. Never
   take the blob snapshot first: a restored database row must not point at a blob that was absent
   from the snapshot. See [Attachment Storage](attachment-storage.md).
4. Back up the Zero replica volume only as an optimization; PostgreSQL remains authoritative.
5. Back up field-encryption keys separately from the database. E2E private-key and workspace-key
   envelopes are in PostgreSQL, but users still need an encryption passphrase, recovery code, or
   remembered browser to open them.
6. Encrypt the backup set, record checksums and a shared backup-set identifier, and test restoration
   on an isolated instance.

## Restore

1. Stop the app and Zero.
2. Restore PostgreSQL into a compatible server with `wal_level=logical`.
3. Recreate separate migration, runtime, and Zero roles; grant runtime access without owner or `BYPASSRLS` membership.
4. Restore the matching attachment snapshot before accepting traffic. Extra unreferenced blobs
   from a newer snapshot are harmless; a database row whose blob is missing is not recoverable.
5. Restore the current and fallback field-encryption keys.
6. Remove the old Zero replica and start Zero so it rebuilds from PostgreSQL.
7. Start Ditero, run migrations, and verify health, login, TOTP, JWT issuance, RLS isolation, sync,
   one encrypted integration credential, and one attachment download and decryption.

Never test a restore by pointing it at the production Zero replica or notification channels.
Read [E2E Key Loss](e2e-key-loss.md) before treating a successful infrastructure restore as proof
that encrypted files remain decryptable.
