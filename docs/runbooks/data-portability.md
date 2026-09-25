# Data export

Open Settings and select **Download JSON** under **Export your data**. The file
contains the workspace content you can currently access, your personal views and
dashboards, preferences, focus sessions, and Karma history. Shared workspace data
is included only while you remain a member. Other members' personal data is excluded.

The version 1 file uses `format: "ditero"`, `schemaVersion: 1`, stable source IDs,
camelCase fields, ISO timestamps, and ordered entity arrays under `data`. It records
the export time, source user, and explicit exclusions in `boundaries`.

This is a data export, not a restorable backup. Settings supports reviewed,
resumable import of a subset of native content; see [Native data format](native-format.md)
for supported records and exclusions. Task assignments require explicit mappings to
current destination members and never create permissions or send assignment notices.
Keep normal database and attachment-storage
backups for disaster recovery.

## Included and excluded data

The export includes workspaces, memberships, folders, lists, tasks, labels, task-label
links, templates, assignments, comments, habit logs, accessible views and dashboards,
and your personal preferences, focus sessions, Karma balance, and Karma events.
Referenced people are represented by ID and display name, without login credentials.
Memberships describe the source data; they are not portable authorization grants.

Saved filters, dashboard panels, home-page preferences, and escalation preferences
can retain IDs for people or content that are no longer accessible. These are source
references, not proof of access or a guarantee that the referenced record is included.
Attachment references can likewise outlive their parent. Import planning reports
unresolved references and maps or omits them explicitly, without creating permissions.

Tasks retain their current completion state and timestamp. Habit logs preserve recorded
occurrences. A full past completion ledger for recurring tasks is not currently stored
and cannot be reconstructed by an export.

Committed attachments appear as references with parent IDs, size and integrity metadata.
Their file contents, encrypted names, wrapped file keys, workspace keys, recovery data,
and internal storage locations are excluded. Attachment files cannot be recovered from
this JSON alone.

Authentication records, sessions, passkeys, invitation tokens, notification credentials,
delivery queues, acknowledgement capabilities, and other operational security state
are excluded. Guardian relationships and managed-account restrictions are authorization
state and are also excluded, as declared by `boundaries.managedAccounts`.
Downloaded JSON contains readable task content; store it accordingly.

## Limits

The authenticated `GET /api/portability/export` endpoint takes a consistent database
snapshot and returns an uncached download. Exports are limited to 50,000 total records
and 32 MiB. A conservative preflight also bounds the memory needed to serialize stored
fields, accounting for compression and JSON escaping; it can refuse some exports below
the output limit. A limit refusal returns HTTP 413 without a partial file. Each export has
a 15-second total deadline, including database connection acquisition. Cancellation
releases its database connection and locks. At most two exports run per app process,
with one per user; extra requests receive HTTP 429 and a retry delay. Interrupted or
failed requests do not alter your content.
