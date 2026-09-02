# Attachment Storage

Ditero encrypts file content, thumbnails, filenames, and declared media types in the browser. The
storage driver sees ciphertext only, but PostgreSQL and the blob store must still be backed up as
one logical set.

## Choose a driver

Use `DITERO_ATTACHMENT_STORAGE_DRIVER=filesystem` for a local or mounted volume. Set
`DITERO_ATTACHMENT_FS_PATH` to a directory writable by the application user; production Compose
mounts its persistent attachment volume at `/data/attachments`. SMB or NFS is supported by mounting
it at that filesystem path rather than exposing a share protocol to Ditero.

Use `DITERO_ATTACHMENT_STORAGE_DRIVER=s3` for an S3-compatible bucket. Clear
`DITERO_ATTACHMENT_FS_PATH`, then set `DITERO_ATTACHMENT_S3_BUCKET` and
`DITERO_ATTACHMENT_S3_REGION`. Set `DITERO_ATTACHMENT_S3_ENDPOINT` for compatible providers that
need one. Supply the access key and secret together, preferably through the `_FILE` variants, or
leave both unset to use workload credentials. The application refuses to start when settings from
both drivers are present, credentials are only half configured, or an endpoint contains URL
credentials.

The bucket does not need browser CORS or public access. All upload and download traffic passes
through Ditero so current membership and role checks are applied at request time.

## Quota and retention

`DITERO_ATTACHMENT_QUOTA_BYTES` is a per-workspace ciphertext quota. Accounting includes reserved
uploads, committed files, and encrypted thumbnails. It is based on bytes observed by the server,
not the client's declared size.

Deletion is soft first. The independently leader-elected sweep removes expired reservations and
attachments whose retention period has elapsed. Configure its retention, cadence, and bounded
batch with `DITERO_ATTACHMENT_RETENTION_MS`, `DITERO_ATTACHMENT_SWEEP_MS`, and
`DITERO_ATTACHMENT_SWEEP_BATCH_SIZE`. Keep the retention period longer than the interval between
complete database-plus-blob backups. A failed blob deletion leaves the database row for retry.

## Backup ordering

For each backup set:

1. Finish a PostgreSQL dump.
2. Snapshot the filesystem volume or S3 bucket after that dump.
3. Record checksums and one identifier tying both artifacts together.

The order is load-bearing. With database first, a restored older database can at worst ignore
newer unreferenced blobs. With blobs first, a later database dump can contain rows for blobs that
did not exist in the snapshot, producing metadata that can never yield content.

For S3, use a point-in-time snapshot, provider backup, or a versioned-bucket inventory whose cutoff
is after the database dump. Object versioning helps rollback accidental changes but does not replace
a coordinated backup.

## Restore outcomes

| Restored material | Outcome |
| --- | --- |
| Matching database, blobs, and field-encryption keys | Infrastructure is restorable; users still need their E2E passphrase, recovery code, or remembered browser. |
| Database without matching blobs | Attachment rows and encrypted metadata may exist, but missing file content cannot be reconstructed. |
| Blobs without the database | Ciphertext remains, but the wrapped per-file keys and parent mapping are gone; it is unrecoverable. |
| Older database plus a newer blob snapshot | Extra unreferenced ciphertext is harmless but may consume storage until cleaned manually. |
| Newer database plus an older blob snapshot | Rows can reference missing blobs; those attachments are unrecoverable. |

Restore while the application and Zero are stopped, put the matching blobs in place before serving
traffic, then verify a real attachment download and client decryption. Follow the full
[Backup and Restore](backup-restore.md) procedure and read [E2E Key Loss](e2e-key-loss.md) for the
separate user-key boundary.
