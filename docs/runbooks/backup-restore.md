# Backup And Restore

## Backup

1. Record the running Ditero and Zero versions.
2. Run `pg_dump --format=custom` against the migration-owner or backup role.
3. Back up the Zero replica volume only as an optimization; PostgreSQL remains authoritative.
4. Back up field-encryption keys separately from the database.
5. Encrypt the backup, record a checksum, and test restoration on an isolated instance.

## Restore

1. Stop the app and Zero.
2. Restore PostgreSQL into a compatible server with `wal_level=logical`.
3. Recreate separate migration, runtime, and Zero roles; grant runtime access without owner or `BYPASSRLS` membership.
4. Restore the current and fallback encryption keys.
5. Remove the old Zero replica and start Zero so it rebuilds from PostgreSQL.
6. Start Ditero, run migrations, and verify health, login, TOTP, JWT issuance, RLS isolation, sync, and one encrypted integration credential.

Never test a restore by pointing it at the production Zero replica or notification channels.
