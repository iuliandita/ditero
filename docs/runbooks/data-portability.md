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
for supported records and exclusions. Version 4 import can preserve task dates,
recurrence, reminders, repeat policy, urgency, and a mapped fallback recipient.
Assignments and fallback recipients require explicit mappings to current destination
members. Import never creates permissions or sends assignment notices. Keep normal
database and attachment-storage backups for disaster recovery.

## Imported task notifications

A version 4 task can show **Pending** while its assignments are still being applied,
or **Blocked** after a conflict or security change. Its content and notification-related
controls stay paused until the task is activated. Resume an interrupted, still-valid
import plan to finish its remaining work. If the plan cannot resume, a current member
who can edit the task may use **Finish import for this task** after reviewing its current
assignees, fallback recipients, and any missing source links. Finishing accepts the
current relationships; it does not restore missing assignments or overwrite task
content. A changed review must be opened again before confirmation.

Automatic reminders begin with eligible future occurrences after activation. Occurrences
that pass while a task is pending or blocked are skipped, including for recipients who
were already active before a later pause. Deliveries queued before the pause may still
arrive. Historical overdue alerts for a newly activated recipient are suppressed;
an explicit change to the task's due date makes that date eligible again, even when
the new date is in the past. Simply reopening or automatically advancing a recurring
task does not clear that historical suppression.

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
occurrences. Version 1 JSON excludes task completion history. It cannot reconstruct
past recurring completions from a task's current state.

## Task completion history

Open a task and expand **Completion history** to see recorded completions, reopenings,
skipped occurrences, and habit status changes. Recording starts when this feature is
installed; earlier actions are not reconstructed. History follows current task access
and is removed when the task is deleted. Names reflect current account information,
including account anonymization, rather than a snapshot of the name at the time.

History loads in pages of 100 records. Offline or incomplete results are marked as
incomplete; an empty cached page does not establish that no history exists. Reconnect
to load missing records.

An action through a reminder link identifies the link's intended recipient. It does
not prove who clicked the link. Native history is retained in database backups but
is not included in version 1 JSON exports.

## History archive

The authenticated `GET /api/portability/export?version=2` endpoint downloads
`ditero-history-v2.json`, including recorded task history and explicit source
attribution for comments, templates, and completion events. It includes only content
you can currently access. It does not reconstruct earlier events or include attachment
files or keys.

This archive cannot yet be imported. Settings **Download JSON** and the endpoint
without a version selector still produce version 1 for the existing import workflow.
An explicit `?version=1` produces the same file. Unsupported or repeated version
selectors return HTTP 400. Both formats share the limits below.

The archive includes a stable installation namespace retained by database backups.
It identifies the source but does not authenticate its claims or grant destination
access. See [Native data format](native-format.md) for the version 2 contract.

## Other export exclusions

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
