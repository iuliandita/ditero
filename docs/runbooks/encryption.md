# Encryption Operations

Generate a 256-bit field key:

```sh
openssl rand -base64 32
```

Provide it as `DITERO_ENCRYPTION_KEY` or `DITERO_ENCRYPTION_KEY_FILE`. Production refuses to start without it. Keep the key outside database backups and application logs.

Encrypted values use `ditero:v1:<fingerprint>:<nonce>:<ciphertext>:<tag>`. The AES-GCM associated data binds each value to its model and field or user-secret kind. Copying ciphertext to another protected field will fail authentication.

Loss of every configured field key makes TOTP, OAuth, JWT signing, and integration credentials unrecoverable. Users must re-enroll or reconnect affected credentials.
