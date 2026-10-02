# Encryption Operations

Generate a 256-bit field key:

```sh
openssl rand -base64 32
```

Provide it as `DITERO_ENCRYPTION_KEY` or `DITERO_ENCRYPTION_KEY_FILE`. Production refuses to start without it. Keep the key outside database backups and application logs.

Encrypted values use `ditero:v1:<fingerprint>:<nonce>:<ciphertext>:<tag>`. The AES-GCM associated data binds each value to its model and field or user-secret kind. Copying ciphertext to another protected field will fail authentication.

Notification channel credentials (`notification_channel.config`) are enveloped the same way; only the secret fields are, so the public ones (ntfy server URL and topic) stay readable. Rows written before this landed are plaintext until backfilled:

```sh
bun run security:encrypt-channel-configs
```

It is idempotent, safe to run on every deploy, and safe to run against a live app (each row is claimed with `SELECT ... FOR UPDATE`, so a concurrent save is never reverted). During a rotation it also re-envelopes already-encrypted secrets under `DITERO_ENCRYPTION_KEY_NEXT`; run it before promoting the new key. The reported count includes only rows rewritten across notification channels, native push registrations, and relay recovery authorities. An idempotent rerun can report zero; that count alone does not prove every credential uses the new key. Verify the rotation and affected operations before retiring the old key, following [Field-Key Rotation](key-rotation.md).

Loss of every configured field key makes TOTP, OAuth, JWT signing, and integration credentials unrecoverable. Users must re-enroll or reconnect affected credentials.
