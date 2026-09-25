# Native data format

The default native JSON format identifies itself with `format: "ditero"` and
`schemaVersion: 1`. It records `exportedAt`, `sourceUserId`, explicit `boundaries`,
and named collections under `data`. The row fields are defined in
`src/domain/portability/v1.ts`. IDs belong to the source; they do not grant access
to records on another instance.

Format validation and graph validation are separate steps. Neither writes data,
creates accounts, or changes memberships. Passing these checks does not mean an
import is authorized or that attachment files can be restored.

## Required relationships

Each collection must have unique primary IDs. Workspace, list, task, label,
assignment, comment, and habit-log relationships must reference the corresponding
exported records. Folder/list and task/label relationships must stay within their
workspace. Task parents must belong to the same list, with at most one level of
subtasks and no cycles.

People referenced by relational author and owner fields must appear in
`principals`. Historical authors do not have to remain workspace members.
Active assignments require membership in the task's source workspace.
Personal views, dashboards, preferences, focus records, and Karma records belong
to `sourceUserId`. Source roles remain descriptive metadata.

## Optional references

Saved filters, dashboard panels, workspace selections, home and pinned views, and
nested escalation preferences can reference deleted or inaccessible records.
These produce warnings for the import plan to resolve explicitly. They must never
trigger an unrestricted lookup of people or content on the destination instance.

An attachment reference without its parent produces a warning. A reference to an
included parent in another workspace is invalid. JSON attachment references do
not include the file contents or decryption keys.

Validation reports use codes and structural paths, without copying task titles,
comments, or other source content into error messages. Input bytes, row counts,
and nesting are bounded before validating recursive structures. The parser accepts
at most 32 MiB, 50,000 rows, 50,000 entries in any nested array, two million values,
and 32 levels of nesting. A graph report retains at most 1,000 findings, including
a terminal limit error; exceeding the report limit fails validation, so a truncated
report cannot authorize an incomplete import plan.

## Version 2 history archive

An explicit `GET /api/portability/export?version=2` returns `schemaVersion: 2`.
Its types are defined in `src/domain/portability/v2.ts`; its parser and graph validator
remain separate. It is an archive only: the current import UI and plan endpoint reject
it with an unsupported-version message and create no saved plan. The default download
remains version 1; existing saved plans retain their format and planner versions.

Version 2 adds `sourceNamespace`, a stable installation UUID. Comments, templates,
and completion events carry `sourceRef` with `namespace`, a canonical collection name,
and `id`. Source IDs can be empty; empty and absent references are different. Source
reference tuples must be unique within their parent task for comments and events, or
within their workspace for templates, comparing UUID namespaces without regard to letter
case. Copies under different parents can retain the same original provenance; their
local row IDs remain distinct within each collection.
These identifiers are untrusted source claims, not evidence of destination ownership.

Comment `author` replaces `authorId`; template `creator` replaces `createdBy`.
Authorship is `native_user` with a reference to an included principal, `source_claim`
with a namespace, nullable source principal ID and display name, or `unknown`.
Source-claimed names are limited to 512 characters. Native exports use current principal
names, including account anonymization. A matching name or ID never authenticates an
external author or supplies author-only permissions.

`completionEvents` records the task, action, `occurredAt`, actor, origin, and the exact
before/after task or habit state. Origin distinguishes a native member mutation from a
reminder-link recipient; external origins can be source claims or unknown, with an
optional label of at most 128 characters. A reminder recipient is not proof of who
clicked. Historical events and habit logs stay valid after the task moves to a different
list kind. Each event still requires its task to exist in the document.

`boundaries.taskHistory` is `recorded-events-only`: no older events are inferred from
current task state. The other exclusions and all parser/export limits remain unchanged.
Retained source claims reexport their original references and claimed event times;
local ingestion time does not replace historical time. Imported comments have no local
author and cannot be edited; workspace admins can delete them. A template's local
operational owner is separate from its historical creator. Redacted attribution exports
as unknown while retaining its source reference. None of these claims grants author
permissions or replays completion, Karma, or notifications. Version 2 import remains
unsupported.

Version 1 cannot represent retained comment authors or template creators. If such rows
are visible, a version 1 export fails with HTTP 409 and `history-requires-v2` before
returning a file. Use version 2 instead; no records are silently omitted or attributed
to a local account. Native-only version 1 exports remain unchanged.

## Saved dry runs

Settings can validate a native file, map its workspaces and people, and save a
dry-run report. Saving does not import content. New plans use planner version 4
and freeze destination checks for later application. Saved version 2 and 3 plans
remain applicable with their original exclusions; save a new plan to include
newly supported task notification settings. Older version 1 plans remain
non-applicable; upload their file again to create a current plan.

Create a named import source for the first file. Explicitly select that same
source for later exports from the same account and installation. Native v1 has
no installation identifier: this selection is your assertion of continuity,
not something Ditero can prove from matching IDs or names. A source is bound to
its original format, schema version, and source user. It cannot be reassigned.

Every source workspace needs an existing writable destination. The exporting
user maps to the caller; other people can remain unmapped or map to applicable
current members. Source roles and memberships never create permissions.
Application supports folders, the exporting user's own lists, labels, tasks,
task-label links, and assignments to mapped current members. Mapping another owner
to your account does not make their lists eligible. Version 4 plans preserve task
due dates, completion, recurrence, reminder time, repeat interval and limit,
urgency, and a fallback recipient. A source fallback person must map explicitly to
a current member of the task's destination workspace. Missing or changed mapping
evidence blocks the affected task; a failed intended assignment also blocks its
notification-bearing task rather than replacing the assignee with the list owner.
Version 2 and 3 plans keep their older dated-task and notification-setting exclusions.
Comments, templates, views, dashboards, focus records, preferences, Karma, and habit
logs remain blocked pending their import policies. Attachment files remain excluded.
Unresolved references and mapping conflicts block affected records and their
dependents. The report distinguishes candidate records, excluded metadata, and
blocked records. Candidates are not a promise that an eventual apply will pass
its authorization and conflict checks.

Each mapped assignee and fallback recipient must be an active member of every
destination workspace in which they are used. Viewers can receive assignments.
Import creates no invitations or memberships and sends no assignment notifications.
Apply rechecks the exact saved membership and task relationship; removing and
recreating a membership requires a new plan. Existing untracked assignments are
conflicts, not adopted rows.
Imported assignments support the normal assign/unassign controls. Removing one does
not authorize a later import to restore it; source omissions never unassign anyone.

Plans store immutable ordered items and a versioned planner report. Identical
content, mappings, and destination checks under the same source return the same
plan, regardless of export timestamp or JSON key order. Changed evidence creates a new plan while
retaining stable source identities. Missing source records never imply deletion.
The dry-run API returns counts, codes, and identifiers, not stored item payloads.

Each account may retain ten sources, ten plans, and 64 MiB of serialized plan
items and reports. Unstarted, completed, and terminal-conflict plans can be
discarded to free this storage; running plans cannot. Completed source mappings
survive plan discard, and a source with retained mappings cannot be discarded.
Each account also has separate limits of 100,000 source mappings, 1,000 workspace
pins, and 64 MiB of combined retained mapping records. Account deletion removes
the import payloads and mappings. Files remain limited to 32 MiB; the settings
mapping form additionally supports up to 50 workspaces and 100 people. Request
mapping data is limited to 2 MiB. Oversized requests fail without partial plans.

The endpoints are `GET /api/portability/import/sources`,
`POST /api/portability/import/plans`, `GET /api/portability/import/plans/:id`,
and `POST /api/portability/import/{plans,sources}/:id/discard`. A plan request
contains `source` (`mode: "new"`, a UUID `id`, and `label`, or
`mode: "existing"` and `id`), the original JSON file as a `document` string,
and `mappings.workspaces`/`mappings.principals` keyed by source IDs. Unmapped
principals use explicit `null`. All routes require a session, and writes require
a same-origin request. The settings download remains an export, not a restorable backup.

## Applying a saved plan

Review the eligible, ignored, and blocked counts, then confirm application.
`POST /api/portability/import/plans/:id/apply` accepts exactly `planDigest` and
`counts` with `ensure`, `ignored`, and `blocked`. The digest and counts must match
the saved report. Each request advances at most 100 immutable items in one
transaction. `GET /api/portability/import/plans/:id/run` returns `{run: null}`
before execution, or progress with `state`, `nextOrdinal`, `appliedCount`,
`noopCount`, and optional conflict code/ordinal. The settings screen sends
successive batches after confirmation and can resume an interrupted run.

Every batch rechecks current write access and locks destination relationships.
An edited, deleted, moved, or conflicting target stops application; it is never
overwritten or redirected. Earlier committed batches remain after a conflict or
pause. A terminal conflict requires a fresh plan. Losing permission before the
first batch refuses the request; losing it during a run stops that run.

Repeated unchanged imports under the same source leave already imported rows
unchanged. Source content changes require a future explicit merge policy; they
do not overwrite edits. Applied workspace mappings remain pinned, while a later
export may add unrelated source workspaces. Existing completion state is copied
without replaying completion events, Karma awards, or notifications.

## Activation and recovery for version 4 tasks

Newly imported tasks remain **Pending** until their notification-affecting
assignments are committed and checked. A later plan that adds recipients to an
active imported task pauses it again until that recipient set is complete. A
conflict or security change can leave the task **Blocked**. While pending or
blocked, automatic task reminders and overdue alerts are paused, and edits to
task fields, completion, recurrence, assignments, and reminder settings are
refused. Authorized deletion remains available. Native tasks and saved version 2
or 3 plans retain their previous behavior.

Resume an interrupted plan when it remains valid. A terminal conflict needs a
fresh plan; resuming does not erase earlier committed batches. If the plan cannot
finish, **Finish import for this task** is a separate, explicit recovery action for
one task. A current owner, admin, or member of its workspace can review the task,
current assignees, owner or escalation fallback, and missing or changed expected
links. A viewer cannot finish it. Review remains available even if the original
source or importer is gone. Review all pages before confirming. The confirmation
accepts the current relationships without repairing missing links, rewriting
source mappings, or replaying old notifications. Review changes require a fresh
confirmation. A previously saved plan cannot resume writing assignments to the
task after manual finish; create and review a new plan if those missing links
are still wanted.

Each activation sets a cutoff for automatic occurrences. Reminders from before
the original import activation are not replayed, and a later pause skips
occurrences before the newly published cutoff for **all** recipients, including
those already assigned. A notification queued before the pause may still be
delivered. New recipients do not get an overdue alert for the task's historical
due date. Existing or returning recipients keep their previous overdue state.
An explicit change to `dueAt` clears that suppression, even if the newly chosen
date is already past; setting the same date, reopening the task, or automatic
recurrence advancement does not. Future occurrences and new due dates follow
normal notification rules once the task is active.
