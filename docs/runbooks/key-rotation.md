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

## Authentication secret rotation

`BETTER_AUTH_SECRET` separately encrypts the JWT plugin's stored JWKS private
keys and two-factor secrets/backup codes, inside the server field-encryption
envelope. Changing it in the environment alone breaks sign-in. Startup refuses
to serve when the stored JWKS cannot be decrypted. Restore the original secret
to recover from an accidental replacement; never delete JWKS or replace the
database to bypass this check.

1. Back up PostgreSQL and the original authentication/encryption secrets and
   verify the backup. Keep all application replicas stopped during this rotation.
2. Load the original `BETTER_AUTH_SECRET`, unchanged `DITERO_ENCRYPTION_KEY` and
   migration-owner `DATABASE_MIGRATION_URL` into the maintenance process from
   your secret manager. Load the new value as `BETTER_AUTH_SECRET_NEXT` (at least
   32 characters). These must be environment variables, not command-line values.
   Leave `DITERO_ENCRYPTION_KEY_NEXT` unset unless also performing field-key
   rotation with the full procedure above.
3. Run `bun run security:rotate-auth-secrets` from the matching source checkout
   or application image. This mode transactionally re-encrypts JWKS private keys,
   TOTP secrets and backup codes with the new authentication secret while
   preserving their contents. Rerunning with the same pair is idempotent.
4. Set every app replica's `BETTER_AUTH_SECRET` to the new value and remove
   `BETTER_AUTH_SECRET_NEXT` from the maintenance environment. Restart and verify
   password login, session loading/JWT issuance, TOTP and a backup code. Existing
   signed cookies are invalidated; users must sign in again. OAuth tokens use
   the separate field-encryption key in this configuration.
5. Preserve the old secret and matching pre-rotation backup for the protected
   rollback window. To roll back, stop all replicas and run the same command
   with the new secret as current and the old secret as next (or restore the
   matching database and secret backup together), then restart and verify.

The original secret is required to decrypt retained data. A failed rotation
rolls back the whole transaction. Do not promote the new secret after a failure.
