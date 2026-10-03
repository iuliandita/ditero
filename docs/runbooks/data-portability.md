# Data export

Open Settings and select **Download JSON** under **Export your data**. The file
contains the workspace content you can currently access, your personal views and
dashboards, preferences, focus sessions, and Karma history. Shared workspace data
is included only while you remain a member. Other members' personal data is excluded.

Settings downloads version 2 with recorded history and source attribution. The legacy
version 1 API file uses `format: "ditero"`, `schemaVersion: 1`, stable source IDs,
camelCase fields, ISO timestamps, and ordered entity arrays under `data`. It records
the export time, source user, and explicit exclusions in `boundaries`.

This is a data export, not a restorable backup. Settings supports reviewed,
resumable import of a subset of native content; see [Native data format](native-format.md)
for supported records and exclusions. Planner versions 4 and 5 preserve ordinary task dates,
recurrence, reminders, repeat policy, urgency, and a mapped fallback recipient.
Assignments and fallback recipients require explicit mappings to current destination
members. Import never creates permissions or sends assignment notices. Keep normal
database and attachment-storage backups for disaster recovery.

## CSV import

Choose **Ditero CSV v1** in Settings to upload a UTF-8 CSV using the
[CSV contract](native-format.md#csv-provider-input). Review the displayed source
namespace and exclusions, map its workspace, and explicitly accept the policy
before saving and applying the dry run. The same namespace and stable list/task
IDs must be retained for subsequent files from that source.

CSV supports lists, tasks and one subtask level, including literal text, completion
state, explicit dates, priority and ordering. It excludes assignments, labels,
comments, templates, history, attachments, recurrence, reminders, personal state,
folders, list customization, shopping fields, task creation times and urgency.
The migration owner establishes operational mapping only, not historical authorship.
It creates no account, membership or source claim. Other providers' CSV formats are
not accepted by this adapter.

## Imported task notifications

A task imported with planner version 4 or 5 can show **Pending** while its assignments are still being applied,
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
and is removed when the task is deleted. Native names reflect current account
information, including account anonymization. Imported records label the person and
origin as source-reported claims; those claims do not identify a local account or
grant permissions. Imported template details likewise label the source-reported
creator without granting local permissions.

History loads native and imported records together in pages of 100 records, including
records with the same timestamp. Offline or incomplete results are marked as incomplete;
an empty cached page does not establish that no history exists. Reconnect to load
missing records. Advancing waits for a complete page.

Authenticated clients can request `GET /api/tasks/history` with `taskId` and
`workspaceId`, then pass the returned `nextCursor` as JSON in the `cursor` query
parameter. Each request checks current membership and task scope. Responses contain
display attribution, not source principal or installation identifiers. A missing,
moved, or inaccessible task returns the same HTTP 404 response.

An action through a reminder link identifies the link's intended recipient. It does
not prove who clicked the link. Native history is retained in database backups but
is not included in version 1 JSON exports.

## History archive

The authenticated `GET /api/portability/export?version=2` endpoint downloads
`ditero-history-v2.json`, including recorded task history and explicit source
attribution for comments, templates, and completion events. It includes only content
you can currently access. It does not reconstruct earlier events or include attachment
files or keys.

Settings accepts this archive and saves an immutable version 5 dry run. Review its
counts and source attribution, then confirm Apply import. Supported comments, task and
list templates, and recorded completion events retain their original times and explicit
source claims. These claims grant no identity, authorship, or destination access.
Historical records do not change current task state, award Karma, or produce reminders
or notifications.
Application rechecks current write access and proceeds in atomic batches of at most
100 items; interrupted runs resume from their committed cursor. Deleted historical
targets remain tombstones. Older preview-only plans cannot be applied; upload the
original archive again and save a new dry run.

Settings **Download JSON** produces version 2. The endpoint without a version selector
and explicit `?version=1` still produce version 1 for existing API clients. Unsupported or repeated version
selectors return HTTP 400. Both formats share the limits below.

If retained source authorship on comments or templates cannot be represented in
version 1, the request returns HTTP 409 with `history-requires-v2`. Request the version
2 archive to preserve those claims. The export never substitutes a local account as
the historical author or silently leaves those records out.

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
