# Field-Key Rotation

1. Back up PostgreSQL and verify the backup before changing keys.
2. Keep the old value in `DITERO_ENCRYPTION_KEY` and set a new 32-byte Base64 value in `DITERO_ENCRYPTION_KEY_NEXT`.
3. Restart the app. New writes use the next key; reads accept both keys.
4. Run the auth-field migration with the migration-owner DSN:

```sh
DATABASE_MIGRATION_URL='postgres://...' \
DITERO_ENCRYPTION_KEY="$OLD_KEY" \
DITERO_ENCRYPTION_KEY_NEXT="$NEW_KEY" \
bun run security:rotate-auth-secrets
```

5. Rotate notification channel credentials, native push registrations, and relay recovery authorities with the same DSN and key pair:

```sh
DATABASE_MIGRATION_URL='postgres://...' \
DITERO_ENCRYPTION_KEY="$OLD_KEY" \
DITERO_ENCRYPTION_KEY_NEXT="$NEW_KEY" \
bun run security:encrypt-channel-configs
```

   Skipping this can leave credentials under the old key and make them unreadable
   after its retirement. The reported count totals only rewritten rows across the
   three credential stores, rather than configured channels. An idempotent rerun
   can report `0 row(s)`; this alone does not prove all credentials have rotated.
   Before retiring the old key, verify retained encrypted credentials use the new
   key and exercise the affected channel, native push, and relay recovery operations.

6. Exercise passkey/TOTP login, OAuth refresh, Zero JWT issuance, and send a test notification on each configured channel.
7. Promote the new value to `DITERO_ENCRYPTION_KEY`, remove `DITERO_ENCRYPTION_KEY_NEXT`, restart, and repeat the checks.
8. Retain the old key only in the protected rollback record until the rollback window closes.

The migration is transactional and idempotent. Backend `user_secret` rows rotate on authenticated reads during step 3.
