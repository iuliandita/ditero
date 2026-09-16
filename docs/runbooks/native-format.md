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

The persistent dry-run plan and content application are separate implementation
steps. The current settings download remains an export, not a restorable backup.
