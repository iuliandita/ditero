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

## Provider imports with content

Settings has separate **Todoist project CSV with content**, **TickTick backup CSV**,
**Microsoft To Do via Outlook CSV**, **Trello board JSON with content**, and
**Generic task CSV** choices. The older Todoist snapshot and plain Trello v1 choices
retain their original exclusions below, including for saved sources and plans.

Upload one UTF-8 file (a leading UTF-8 BOM is accepted), choose names for missing
project/list names, and set an IANA time zone for dates without offsets. Review the
field notices, map the destination workspace, accept the policy, then save a dry run.
Saving writes the plan only. Apply uses the same authorized, resumable import pipeline
as native imports. People, permissions, assignments, attachments, credentials,
reminders, urgency and history are excluded. Import sends no assignment notifications
and suppresses historical overdue alerts. Future ordinary due-date alerts still follow
normal task notification policy after activation.

| Picker | Supported source and mapping | Limits shown in preview |
| --- | --- | --- |
| Todoist with content | One project CSV: sections become lists under the chosen folder; titles, descriptions, priorities, `@labels`, note rows, indentation and explicit dates are converted. | Todoist CSV has no completion state, so tasks are open. Todoist writes DATE as the text its app displayed, so the adapter reads ISO dates and the common displayed forms (`Oct 21`, `21 Oct 2026 14:00`, German, Spanish, French and Romanian month names) and English recurrences (`every day`, `every 2 weeks`, `every other day`, `every weekday`, `every monday`, `every month on the 15th`, `every jan 31`, optional `starting <date>`). Todoist drops a recurrence's start date on export, so recurring tasks without one begin on the day shown in the preview notice (day of the conversion, in the chosen time zone). Relative dates (`tomorrow`), completion-relative `every!`, `until`/`for` rules, other-language recurrences, deadlines, durations, authors and view settings are excluded with a located notice. The exact DATE text of real exports could not be verified against an account; check the preview. |
| TickTick | A backup CSV with `Folder Name,List Name,Title` and `taskId,parentId` columns: folders, list/column placement, notes, tags, priorities, dates, completion and checklist children are converted. | This adapter targets the backup CSV layout, not TickTick API JSON. Reminders, rich task kinds, source timestamps and provider-specific repeat expressions are not retained. Backup status 1 is completed, status 2 (archived) and -1 (won't do) are imported as completed with a notice, and a completion time is kept only for completed tasks. Floating times keep their clock time in the chosen zone. Subtasks follow their parent's list. Backups in the wild can contain rows with unescaped delimiters: stray quotes are tolerated, short rows are padded and noted, and rows with extra values are skipped with their row number. |
| Microsoft To Do | An English classic Outlook Tasks CSV, one task folder at a time: subject, notes, categories, importance, status, due date and completion date are converted. Enter the original list name. | To Do account export is a mailbox PST, which this adapter cannot read. Outlook CSV can omit steps, recurrence, reminders, other lists and records outside its selected date range. No missing content is inferred. Outlook writes dates in the Windows regional order: the adapter detects it from the dates (a day or month above 12), rejects files that mix both, and asks you to choose month/day/year or day/month/year when the file cannot tell; the choice is bound into the source. Progress, waiting and deferred states become open with an explicit notice, items marked private are reported because they follow the workspace's sharing after import, and identical rows stay separate tasks. Localized Outlook headers and non-UTF-8 files require conversion to the generic contract. |
| Trello with content | One board JSON: board becomes a folder, lists become lists, cards become tasks, checklist items become children, labels and dates are retained. `dueComplete` supplies completion. Archived cards and cards in archived lists are imported as completed with their own notice, so they do not reopen as active work; a closed board is only reported. Comment text is appended to notes, oldest first, with its day. | JSON may contain only 1,000 recent actions/comments. Comments lose authorship; activity, members, attachments, board descriptions, checklist headings, custom fields, colors and other metadata are reported as excluded. Template and special-role cards are refused. CSV, workspace ZIP and account completeness are not supported. |
| Generic CSV | The contract below: lists, sections, notes, one-level children, labels, priority, completion, explicit dates and supported recurrence. | Unknown nonempty columns are reported; inconsistent references and conflicting duplicate IDs are refused. |

Deeper subtasks are flattened under their top-level task with an explicit notice.
Identical duplicate IDs/rows are deduplicated; conflicting duplicates are refused.
Comments become literal notes without claiming a local author. Notes and titles
remain text, including formula-like strings, and imported source content is never
executed. Ditero has no CSV download today; any future one must escape spreadsheet
formula prefixes.

One bad value does not fail the file. Titles and names longer than 500 characters and
notes beyond 32 KiB are shortened, unreadable rows are skipped, and unreadable fields
are ignored; each is listed in the preview with its row (or Trello card) and field.
Only structural problems (encoding, quoting, JSON, conflicting IDs or references,
file limits) stop the import, and the message names the row where one is known.

Labels are created, not merged. A label whose name already exists in the target
workspace is blocked together with its links on imported tasks (the tasks themselves
import), and the preview names those labels before you apply. Reusing existing labels
needs a new reviewed apply precondition and is not part of these adapters yet.

Explicit ISO dates and times with offsets are normalized to UTC. Offset-free times
use the selected/source IANA zone; ambiguous or nonexistent daylight-saving times
are excluded with a notice. A date without a time has no zone: it always lands on the
calendar day of the selected zone (a row's own zone is ignored), starting at the first
real instant of that day. Unsupported dates are never guessed. Only all-day,
known-anchor recurrence expressible by Ditero's RRULE engine is retained; timed,
unanchored and completion-relative rules are excluded to avoid changing timezone
behavior. Check all converted dates and completion states before applying.

The original bytes, provider, names, timezone and exact notices form an immutable
`provider-content` version 2 binding. Its deterministic snapshot namespace and task
IDs support identical retries only. Any byte or configuration change requires an
explicit **New source**, which creates separate copies. These adapters do not merge
later provider exports or synchronize accounts. Browser hashing requires HTTPS or
localhost. Raw upload size is limited to 23 MiB to fit the bounded request envelope;
conversion also enforces 50,000 rows, 32 KiB fields, strict quoting, bounded JSON and
at most 512 notice groups (per-row notices beyond 300 fold into one entry, and
counts stop at 50,000). Nested JSON deeper than 32 levels is rejected before it is parsed. Unsupported encodings, malformed rows, reference cycles,
prototype-pollution keys and inconsistent duplicate IDs fail before a plan is saved.
Convert UTF-16/legacy encodings to UTF-8 locally first; PST and ZIP are not text files.

### Generic CSV columns

Use a comma-separated UTF-8 file with a header and required `title` column. Optional
columns are `id,list,section,parent_id,notes,due,timezone,priority,labels,completed,
completed_at,recurrence`. Quote fields containing commas, quotes or newlines using
standard CSV quoting. `list` defaults to the chosen list name; when `section` is supplied, the list name becomes a folder and each section
becomes a list. `parent_id` references `id` in the same list. Supply stable IDs within the
file when referring to parents; omitted IDs use row numbers within this snapshot.
`priority` is 0 (none), 1 (low), 2 (medium), or 3 (high). Labels are separated by
semicolons. Completion accepts `true/false`, `1/0`, or `Y/N`; empty means open.
Dates use `YYYY-MM-DD` or ISO date/time. `timezone` overrides the selected zone per
row. `recurrence` accepts supported `FREQ=...` RRULE text or the simple English
phrases described above, with an explicit all-day `due` anchor.

```csv
id,list,title,parent_id,due,priority,labels,completed
parent,Household,Prepare picnic,,2026-07-18,2,home;weekend,false
child,Household,Pack cups,parent,,0,home,true
```

### Provider export references

The checked-in fixtures are synthetic, contain no personal data, and exercise the
supported layouts and exclusions. They do not establish full provider-account or
native-platform qualification. Export documentation was checked on October 21, 2026:

- [Todoist project CSV fields and limits](https://www.todoist.com/help/todoist/features/import-or-export-a-project-as-a-csv-file-in-todoist-YC8YvN).
- [TickTick backup and import](https://help.ticktick.com/articles/7055781405648748544). TickTick documents the backup workflow, but does not publish a complete CSV field schema; verify the preview against your backup.
- [Microsoft To Do account export](https://support.microsoft.com/en-gb/office/exporting-your-microsoft-to-do-account-d286b243-affb-4db4-addc-162e16588943) and [classic Outlook CSV workaround on Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/4647043/copying-to-do-tasks-from-one-ms-account-to-another). The workaround is not a full-fidelity To Do export.
- [Trello export availability and comment limits](https://support.atlassian.com/trello/docs/exporting-data-from-trello/) and [JSON object definitions](https://developer.atlassian.com/cloud/trello/guides/rest-api/object-definitions/).

## Todoist project CSV snapshots

Choose **Todoist project CSV snapshot** for a UTF-8 project export using Todoist's
`TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE,DURATION,DURATION_UNIT,DEADLINE,DEADLINE_LANG`
header. The documented optional final `IS_COLLAPSED` column is accepted as an
excluded view setting. Enter a project folder name and a list name for unsectioned
tasks explicitly: the file has no project identity. Every section becomes a
separate list with its literal name, including duplicate and empty sections.

Version 1 imports literal task titles, task descriptions as notes, priority,
file ordering and one level of subtasks. Todoist priorities 1 through 4 map to
Ditero priorities 3 through 0; an empty priority uses Todoist's default of 1.
Unknown headers, record types, orphan children and deeper indentation are refused.
Text resembling labels, Markdown or spreadsheet formulas stays literal.

All dates are excluded, including explicit dates, natural-language dates and
recurrence. Deadlines, durations, authors, assignees, note/comment rows, structured
labels, templates, attachments, history, completion state, reminders, personal state,
project/section descriptions, view settings, shopping fields, creation times and
urgency are also excluded. Every imported task is an open copy. The migration
owner supplies operational mapping only, never source authorship. Accept these
boundaries explicitly before previewing or applying, including a saved plan.
Changing the file or configuration resets that acceptance.

Snapshot hashing in the browser requires HTTPS or localhost. A plain HTTP LAN
installation shows a secure-connection requirement instead of starting conversion.

Each source is an immutable snapshot of the exact original bytes: the full SHA-256,
a deterministically derived UUID namespace, both mapping names and the ordered
exclusion policy are bound together. Identical bytes and metadata replay that
source. Any byte change, including a BOM, line ending, excluded field or new row,
is a different snapshot. Reusing the source returns HTTP 409 with
`source-binding-conflict`. Choose **New source** explicitly to import a separate
copy. Record numbers identify rows only inside one snapshot; this adapter does
not offer incremental updates or claim Todoist account completeness. The checked-in
fixture is synthetic and follows the documented format.

## Trello board JSON (v1)

Settings accepts one UTF-8 JSON file for a single Trello board. The board name
becomes a folder, its lists become task lists, and plain open cards become top-level
tasks. Card names become titles and card descriptions become literal notes. Lists
and cards follow their `pos` order, with the canonical ID as the tie-breaker. Tasks
are open copies with priority 0, no dates and no subtasks.

An archived board, list or card is refused, as is a card with `dueComplete` true,
a template card, or a card with a non-null special `cardRole`. Duplicate IDs, lists
or cards from another board, and cards on a list missing from the file are also
refused.

These are excluded: dates, completion state, recurrence, authors, assignments,
comments, labels, checklists, attachments, history, reminders, personal state,
custom fields, covers, stickers, view settings, plugin data, task creation times,
shopping fields, urgency and board descriptions. Accept this policy explicitly
before previewing or applying. Changing the file resets that acceptance.

Snapshot hashing in the browser requires HTTPS or localhost. The source namespace
is derived from a hash of the board ID, not from the file. The source is bound to
the SHA-256 of the exact original bytes, including excluded fields and whitespace,
and to the ordered exclusion policy. Reusing the source with changed bytes returns
HTTP 409 with `source-binding-conflict`. Choose **New source** explicitly to import
a separate copy. This adapter is not an incremental update, a sync or a full-fidelity
board copy. The migration owner supplies operational mapping only, with no local
grants or source authors.

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

## Encrypted attachment archives

Attachment archive export is available in the browser and Linux desktop app.
Android, Windows and macOS require the browser. Archive import and recovery remain
browser-only. Sign in to the relevant server and unlock **Encrypted files** first. Source files need their available
keys; importing also requires current write permission and an available encryption
key for the applied destination. Import creates no memberships or permissions.

### Export a matching pair

1. In Settings, select **Export data and attachments**. Wait for saved changes and
   available files, then choose the committed list, task or comment attachments
   to include. Files without an available key or matching saved metadata cannot
   be selected. Each file shows its source and upload time to help distinguish
   matching filenames; displayed file sizes count encrypted data.
2. Check the selected file count. Enter **Export password** and **Confirm export
   password**, using a separate password from your account password. Select
   **Prepare export**.
3. Select both **Download app data** and **Download encrypted attachments** and keep
   those two files together. The app data JSON contains readable tasks, lists,
   comments, and other Ditero data. The attachments file is encrypted with your
   export password. Keep that password: it is required to open the archive.
   On Linux desktop, each button opens a separate system save dialog. **Saved**
   appears only after the file is written successfully; canceling a save leaves
   that file unconfirmed. Canceling or failing to save keeps the prepared pair
   available. Use the same download button to choose a destination and retry.
   Each file shows the outcome of its latest save attempt; retrying one file
   does not clear the other file's successful save.

Language changes wait for local saving and server confirmation before reloading.
Stay connected until the language changes; export requires confirmed saved changes.
At startup, Ditero restores your saved language before detecting your time zone.

Use the exact content JSON downloaded with that files archive. A separate
**Download JSON** export, an edited file or a reserialized copy is not a substitute,
even if its content looks identical. Each JSON file is limited to 32 MiB; the
archive supports up to 64 files, 16 MiB of encrypted file data and 32 KiB of protected
metadata. A selection may reach a limit before reaching 64 files.

### Import the files after their content

1. On the destination server, use the paired content JSON as **Native JSON export**
   under **Plan an import**. Review workspace and people mappings, select
   **Save dry run**, then review and confirm **Apply import**. If this content was
   already imported, reopen its existing saved plan instead of creating another
   source or applying a separate copy just to retry files.
2. Once that plan is completed, select **Import selected files**. When reopening a
   saved plan, choose its original **Exact paired content JSON** again; the same
   document remains available when continuing directly from the loaded import.
   Choose **Encrypted files archive**, enter its **Archive passphrase**, and select
   **Open archive**. The destination account may differ from the exporting account.
3. Choose one file and review its **Applied destination:**. The browser checks its
   retained server status first. **File committed and confirmed by the server.**
   confirms prior completion without importing another copy. For a new transfer,
   select **Prepare file**, then **Transfer prepared file**. Preparation alone does
   not transfer anything; files are re-encrypted for the destination. Blocked files
   show a reason.

### Uncertain outcomes and recovery

If the server outcome is uncertain, keep the dialog open and select **Check server
status** before deciding whether to use **Retry this attempt**. Retry uses the same
prepared attempt. Stopping or closing cancels local work and does not confirm a
server undo; **Cancel server reservation** also requires server confirmation.

Prepared retry data stays in memory only while this operation remains open.
Closing, reloading, changing accounts or losing the key session discards it.
Reopen the same completed saved plan with the original paired content JSON, files
archive and archive passphrase, then choose the file to inspect its retained
server status. Confirmed completion remains recorded even if the destination file
was later deleted.

When replacement is permitted, select **Replace file transfer**, review the
warning, then select **Confirm replacement**. This explicitly abandons the retained
attempt, including any upload still in progress, and starts a fresh encrypted
transfer to the same applied destination. An uncertain replacement response must
be checked before retrying; retry retains the same prepared replacement attempt.
Recovery does not reapply the content import or create permissions.

Retired attempts continue to count toward attachment quota until garbage
collection removes their stored files and reservation rows. A replacement can
therefore be refused for insufficient quota while cleanup is pending. This
recovery flow is browser-only; it remains unavailable in Android and desktop apps.

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
