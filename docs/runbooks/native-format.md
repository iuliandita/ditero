# Native data format

The native JSON format identifies itself with `format: "ditero"` and
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

## Saved dry runs

Settings can validate a native file, map its workspaces and people, and save a
dry-run report. Saving does not import content. New plans use planner version 2
and freeze destination checks for later application. Older version 1 plans remain
non-applicable; upload their file again to create a current plan.

Create a named import source for the first file. Explicitly select that same
source for later exports from the same account and installation. Native v1 has
no installation identifier: this selection is your assertion of continuity,
not something Ditero can prove from matching IDs or names. A source is bound to
its original format, schema version, and source user. It cannot be reassigned.

Every source workspace needs an existing writable destination. The exporting
user maps to the caller; other people can remain unmapped or map to applicable
current members. Source roles and memberships never create permissions.
Application currently supports folders, the exporting user's own lists, labels,
tasks without notification settings, and task-label links. Mapping another owner
to your account does not make their lists eligible. Tasks with a reminder time,
repeat interval, repeat limit, fallback recipient, or urgent flag are blocked;
these settings are never silently removed.
Unfinished tasks with a due date are also blocked, including habits: automatic
overdue alerts do not require a reminder setting. Completed dated tasks and
undated tasks remain eligible when they have no reminder settings. Assignments, comments, templates,
views, dashboards, focus records, preferences, Karma, and habit logs remain
blocked pending their import policies. Attachment files remain excluded.
Unresolved references and mapping conflicts block affected records and their
dependents. The report distinguishes candidate records, excluded metadata, and
blocked records. Candidates are not a promise that an eventual apply will pass
its authorization and conflict checks.

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
