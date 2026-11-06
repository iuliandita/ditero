# Attachment Storage

Ditero encrypts file content, thumbnails, filenames, and declared media types on the client. The
storage driver sees ciphertext only, but PostgreSQL and the blob store must still be backed up as
one logical set.

Encrypted attachments default to disabled (`DITERO_E2E_ENABLED=false`). Set
`DITERO_E2E_ENABLED=true` in the application deployment configuration and restart
the app to opt in. While disabled, `/api/e2e/*` and `/api/attachments/*` return
`404`. Browser encryption requires HTTPS or a browser-secure loopback origin with
Web Crypto available, plus account key enrollment and a workspace key grant.
Plain HTTP on a LAN is insufficient. See the deployment examples for
[Compose](../../README.md#encrypted-attachments),
[Helm](../../deploy/helm/ditero/README.md#configuration-and-operations), and
[Kustomize](../../deploy/kustomize/README.md#configure-an-overlay).

## Choose a driver

Use `DITERO_ATTACHMENT_STORAGE_DRIVER=filesystem` for a local or mounted volume. Set
`DITERO_ATTACHMENT_FS_PATH` to a directory writable by the application user; production Compose
mounts its persistent attachment volume at `/data/attachments`. SMB or NFS is supported by mounting
it at that filesystem path rather than exposing a share protocol to Ditero.

With encrypted attachments enabled, startup requires this directory to already
exist and verifies it by creating, writing and removing a private probe file as
the application user. A missing, read-only or unwritable directory fails startup
with its path and error code (for example `ENOENT`, `EROFS` or `EACCES`). Provision
the directory and its UID/GID permissions before enabling the feature. The probe
does not create the directory or change ownership. Storage errors during later
uploads log their error codes without filenames or other plaintext metadata. Each upload claims
an exclusive transfer token in a short transaction, releases the database client while streaming,
and rechecks current access and reservation state before recording the observed bytes and hash.
Non-size storage failures leave the reservation retryable. A failed completion transaction releases
its lease on a best-effort basis; a new transfer may take over a stalled lease after five minutes.
A takeover fences the previous transfer. Identical thumbnail retries succeed without replacing
the recorded thumbnail; differing bytes are refused. Reservation expiry still applies.

In a rare interruption, GC may remove an expired row while its stream is still running, and the
process may then crash after storage publishes the object but before completion removes it.
The unreferenced ciphertext is not downloadable through the app, but can remain in storage.
Reconcile an offline blob inventory against a coordinated database snapshot before removing
confirmed orphan objects; preserve backups and never infer orphan status from an object's age alone.

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

On develop after alpha.10, browser uploads prefer private-file ciphertext staging
when the required OPFS and Web Locks operations are available. Otherwise, they
buffer ciphertext only, with an 8 MiB combined limit for each file and its
thumbnail, then send the encrypted Blob through XMLHttpRequest. Oversized files
are rejected before reservation; this fallback limit is separate from server
limits and workspace quota. Only one buffered upload runs at a time. If neither
browser transport is available, use another browser or device; increasing server
quota cannot add browser capabilities. Native attachment transports retain their
streaming path. These changes do not qualify an unfinished native transfer
journey or change alpha.10 downloads.

Browser previews and ordinary downloads are limited to 64 MiB in memory. Larger downloads
require a browser with the File System Access save picker, OPFS, and Web Locks. The client asks
for a destination, stages ciphertext in browser storage, verifies the entire stream without
retaining plaintext, then decrypts the same file snapshot again into the selected destination.
This uses bounded memory but requires enough temporary browser storage for the ciphertext and
two decryption passes. Unsupported browsers refuse large files with an explanatory message.
The server quota does not imply browser support for an equally large preview.

Android and desktop development apps use native HTTPS transfers and system save
pickers. Downloads stage ciphertext privately and verify the complete stream before
writing plaintext to the chosen destination. On develop after alpha.10, comment
attachments use the same native upload transport as task files; browser comment
uploads retain the browser transport described above. Their platform qualification is bounded;
see the [Android](../../apps/android/README.md#encrypted-files) and
[desktop](../../apps/desktop/README.md#encrypted-files) guides.

Only ciphertext is staged in OPFS. New stages are protected by per-file Web Locks while active;
startup and subsequent transfers recover abandoned stages after a renderer crash. Legacy
`ditero-upload-` stages are left alone because an older open tab does not hold these locks.
Close all Ditero tabs before clearing legacy site storage, and preserve any remembered-key or
recovery material first. Storage quota or destination write failures stop the download; they do
not fall back to buffering the entire file. Canceling after choosing a new destination can leave
an empty file, but unauthenticated content is never written to it.

`DITERO_ATTACHMENT_QUOTA_BYTES` is a per-workspace ciphertext quota. Accounting includes reserved
uploads, committed files, soft-deleted files retained for restoration, and encrypted thumbnails.
Reservations count declared bytes; uploaded files count bytes observed by the server. Deleting a
file frees quota only after garbage collection removes its blobs and database row. Migration
reservations and replacements use the same configured quota and combined file/thumbnail limit.

When retained deleted files contribute to a quota refusal, upload and archive import show their
retained byte count and latest restore-window end in the current language. The API returns
`quota-retained-deleted`, `retainedDeletedBytes`, `restoreWindowEndsAt`, and `gcPending` with
status 409. The date is the latest window, not a promise that enough space becomes available
then. After the windows end, the message reports pending cleanup; check the sweep logs if it
persists. Other files and reservations can still consume quota.

Deletion is soft first. The independently leader-elected sweep removes expired reservations and
attachments whose retention period has elapsed. Configure its retention, cadence, and bounded
batch with `DITERO_ATTACHMENT_RETENTION_MS`, `DITERO_ATTACHMENT_SWEEP_MS`, and
`DITERO_ATTACHMENT_SWEEP_BATCH_SIZE`. Keep the retention period longer than the interval between
complete database-plus-blob backups. A failed blob deletion leaves the database row for retry.
Failed rows receive a persisted five-minute retry delay. Each batch considers untried rows before
previous failures, so one broken object does not starve later candidates. Each sweep logs deleted,
failed, candidate and deferred counts; repeated failures or growing deferred counts require
checking storage availability and permissions. Quota remains occupied until deletion succeeds.

A writable uploader can delete their own file even after its keys are lost. Other writable
members can delete recoverable files; only owners and admins can delete another uploader's
unrecoverable file. A current member denied an individual deletion receives
`attachment-delete-forbidden` with status 403. The file menu follows the same rule.
Deleting a task, comment or list follows that parent's existing authorization and retires all
its attachments, including unrecoverable files from other uploaders. Those files belong to the
deleted container and would otherwise be unreachable. The parent deletion transaction checks
and locks that authorization; individual file deletion does not authorize parent deletion.

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
traffic, and restore the original feature configuration and keys, including
`DITERO_E2E_ENABLED=true` when previously enabled. Preserve key envelopes and ciphertext;
do not generate new keys or reenroll accounts to bypass a configuration problem.
Then verify a real attachment download and client decryption. Follow the full
[Backup and Restore](backup-restore.md) procedure and read [E2E Key Loss](e2e-key-loss.md) for the
separate user-key boundary.

When upgrading notification channels alongside attachment storage, follow the
[notification upgrade and rollback guidance](backup-restore.md#notification-channel-safeguards-upgrade).
Migration 0097 changes channel health codes only; attachment recovery still needs
the coordinated database, blobs and original keys described above.
