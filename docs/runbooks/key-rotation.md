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

5. Exercise passkey/TOTP login, OAuth refresh, Zero JWT issuance, and configured notification channels.
6. Promote the new value to `DITERO_ENCRYPTION_KEY`, remove `DITERO_ENCRYPTION_KEY_NEXT`, restart, and repeat the checks.
7. Retain the old key only in the protected rollback record until the rollback window closes.

The migration is transactional and idempotent. Backend `user_secret` rows rotate on authenticated reads during step 3.
