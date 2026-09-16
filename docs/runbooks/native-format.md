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
dry-run report. Saving does not import content. Reports always state
`applySupported: false`; there is no apply endpoint or control.

Create a named import source for the first file. Explicitly select that same
source for later exports from the same account and installation. Native v1 has
no installation identifier: this selection is your assertion of continuity,
not something Ditero can prove from matching IDs or names. A source is bound to
its original format, schema version, and source user. It cannot be reassigned.

Every source workspace needs an existing writable destination. The exporting
user maps to the caller; other people can remain unmapped or map to applicable
current members. Source roles and memberships never create permissions.
Historical comments and templates authored by someone else remain blocked,
even if that person maps to a destination account. Personal preferences, Karma,
and habit logs await an explicit merge policy. Attachment files remain excluded.
Unresolved references and mapping conflicts block affected records and their
dependents. The report distinguishes candidate records, excluded metadata, and
blocked records. Candidates are not a promise that an eventual apply will pass
its authorization and conflict checks.

Plans store immutable ordered items and a versioned planner report. Identical
content and mappings under the same source return the same plan, regardless of
export timestamp or JSON key order. Changed content creates a new plan while
retaining stable source identities. Missing source records never imply deletion.
The dry-run API returns counts, codes, and identifiers, not stored item payloads.

Each account may retain ten sources, ten plans, and 64 MiB of serialized plan
items and reports. Discard a plan or a whole source to free storage. Account
deletion removes these payloads. Files remain limited to 32 MiB; the settings
mapping form additionally supports up to 50 workspaces and 100 people. Request
mapping data is limited to 2 MiB. Oversized requests fail without partial plans.

The endpoints are `GET /api/portability/import/sources`,
`POST /api/portability/import/plans`, `GET /api/portability/import/plans/:id`,
and `POST /api/portability/import/{plans,sources}/:id/discard`. A plan request
contains `source` (`mode: "new"`, a UUID `id`, and `label`, or
`mode: "existing"` and `id`), the original JSON file as a `document` string,
and `mappings.workspaces`/`mappings.principals` keyed by source IDs. Unmapped
principals use explicit `null`. All routes require a session, and writes require
a same-origin request. Content application remains a separate implementation
step. The settings download remains an export, not a restorable backup.
