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

It is idempotent and also re-envelopes under `DITERO_ENCRYPTION_KEY_NEXT` during a rotation, so it is safe to run on every deploy.

Loss of every configured field key makes TOTP, OAuth, JWT signing, and integration credentials unrecoverable. Users must re-enroll or reconnect affected credentials.
