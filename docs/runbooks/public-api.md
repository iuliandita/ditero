# Public API

The versioned API provides discovery, idempotent list and task creation, scalar
updates, observed task completion and deletion, and authenticated iCalendar
snapshots, fixed-list calendar subscriptions and list-bound task webhooks.
Write tokens do not grant workspace access.

## Tokens

Open account settings in the browser and select Personal access tokens. Create a
named token with Read access unless a supported write operation requires Write.
Expiry defaults to 90 days and is limited to 365 days. Each account can have up to
20 active tokens. The full token appears once; store it in a secret manager.
Listing tokens returns metadata only. Revoke unused tokens in the same settings
section. Account deletion removes token records.

Token management requires a browser session and same-origin requests. A bearer
token cannot create another token. Native accounts open browser settings for this
operation.

Send tokens only over trusted HTTPS connections. Supply `Authorization: Bearer`
with the token from a protected environment or credential store. Never put a
token in a URL, command-line argument, shared log or source file.

## Discovery

`GET /api/v1/openapi.json` returns the OpenAPI 3.1 description without authentication.
All other endpoints require a bearer token:

- `GET /api/v1/me`: account ID/name, timezone and whether it was explicitly chosen,
  locale, server time and token access.
- `GET /api/v1/{resource}` and `GET /api/v1/{resource}/{id}`: workspaces, lists,
  tasks, people, labels, views and dashboards.

Collections accept `limit` (1-100, default 50), `cursor` and `workspaceId`.
Tasks additionally accept `listId` and `done=true|false`. Unknown and repeated query
parameters are rejected. Responses have `{ "version": 1, "data": ..., "nextCursor": null }`.
For collections, follow a non-null `nextCursor` until it becomes null; keep the
resource and filters unchanged. Pages are ordered by stable ID and represent live
reads, so concurrent edits can change results between requests.

Actual workspace membership governs visibility, including Viewer read access.
Personal views and dashboards remain owner-only. People discovery returns only
accounts in common workspaces and omits email addresses. Missing and inaccessible
IDs both return 404. Task responses include stable assignee and label IDs.

A dashboard is a projection of tasks stored in lists. Agents must inspect its
panels and referenced views to identify an authorized backing list. A person's
name is not an account ID, and a label is not an assignment. Ambiguous names,
multiple possible lists and invitations require an explicit choice; discovery
never grants access. Resolve relative dates using the account's timezone, and
ask for a timezone when `timezoneChosen` is false.

## List creation

`POST /api/v1/lists` requires a write token, current Member/Admin/Owner membership
in the workspace, JSON content and a caller-supplied UUID `Idempotency-Key`.
No query parameters are accepted. The complete UTF-8 JSON body is limited to 4 KiB.

```json
{ "workspaceId": "WORKSPACE_ID", "title": "Groceries", "kind": "shopping", "icon": null }
```

Workspace, title and kind are required. Title is trimmed and limited to 500
characters. Kind is exactly `tasks`, `shopping`, `checklist`, `project` or `habits`.
Icon may be a named icon or emoji of at most 128 characters; omitted and null mean
the per-kind default. Unknown fields, NUL and malformed Unicode are rejected.
The server assigns a new UUID, the caller as owner, a root append position,
no folder and `completedDisplay: "sink"`. No tasks, invitations or access grants
are created.

Fresh success returns 201 with
`data: { "kind": "list-create-ack", "snapshot": { ... } }` in the standard version-1
envelope. The snapshot has the existing list DTO fields. List and receipt commit
atomically. Keep the key and body after an uncertain transport outcome. Matching
canonical replay returns 200 with the immutable original creation snapshot; title
trimming and omitted/null icon normalize identically. Keys are account-scoped and
shared with all task writes; a different operation or canonical body returns
`409 idempotency-conflict`.

The acknowledgement does not assert current existence or identify the current
incarnation of its list ID. Editing, deleting or recreating that ID does not change
the original snapshot, and replay never recreates or modifies a list. Use a separate
authorized `GET /api/v1/lists/{id}` for current state. Replay still requires current
write-token and write-membership authority in the original workspace, even if a
replacement list has different authority. Missing membership/workspace returns 404,
Viewer/read-token access returns 403, and revoked or expired credentials return 401.
Account deletion removes receipts.

## Observed list metadata updates

Read `GET /api/v1/lists/{id}/observation` before editing. Read tokens and Viewers
may observe visible lists. Its envelope contains `data.snapshot`, the strict
existing ApiList DTO, and `data.stateToken`, SHA256 of a version-1 canonical scalar
snapshot. All ApiList fields are covered: ID, workspace, owner, title, kind, icon,
folder, order (`sortKey`) and completed-display policy. Tasks, memberships, folder
contents and other relationships are outside this token. The read takes no lock.
The token is not monotonic or a durable incarnation identity: returning to identical
state, including deleting and identically recreating an ID, may match again.

`PATCH /api/v1/lists/{id}` requires a write token, current Member/Admin/Owner
membership, JSON content and a caller-owned UUID `Idempotency-Key`. No query
parameters are accepted. The complete UTF-8 body is limited to 4 KiB:

```json
{
  "workspaceId": "ORIGINAL_WORKSPACE_ID",
  "expectedState": "COPY_OBSERVATION_STATE_TOKEN",
  "patch": { "title": "Groceries", "icon": null, "completedDisplay": "hide" }
}
```

Supply the original observed workspace and token. The nonempty patch accepts only
`title` (trimmed, 1-500 characters), `icon` (null or at most 128 characters, using
creation semantics), `completedDisplay` (`sink`, `keep`, `hide`), nullable
`folderId`, and `sortKey`. Omitted fields preserve values. ID, workspace, owner and
kind are immutable through this endpoint. Unknown fields, NUL, malformed Unicode and invalid enums are refused.
After native authority/container locks, a different captured scalar state returns
`409 list-state-changed` without mutation. Changed metadata or placement on lists with pending or
blocked import activation returns `409 activation-pending`; an unchanged patch can
succeed. Authority refusals take precedence over stale state.

Placement uses `patch: { "folderId": "FOLDER_ID", "sortKey": "a1xyz" }`.
The folder must belong to the original workspace; null detaches, and omission
preserves it. Initially missing or foreign targets return 404 after current PAT
validation; a target deleted during canonical locking may return 503. A sort key
must be a valid opaque base-62 fractional key of 2-256 ASCII characters. Existing
jitter is preserved; keys are never trimmed or regenerated. Only the observed
list is guarded, not sibling ordering. Pending/blocked import activation prevents
changed placement. Replay returns the original acknowledgment even if its target
folder is gone; it does not move a replacement list. Preserve the exact key/body
after uncertain transport, and explicitly observe again for a new intent.

The canonical native mutation and receipt commit atomically. Success and matching
replay return 200 with `data: { "kind": "list-update-ack", "snapshot": { ... } }`.
This immutable original post-update snapshot survives later edits, deletion and ID
recreation. Replay never mutates a current list or asserts its incarnation/existence.
Use a separate authorized GET for current state. Replay requires a live actor, valid
write PAT and current writable membership in the original workspace, even when the
original list is absent or a replacement belongs elsewhere. Missing original
workspace/membership returns 404, Viewer/read tokens 403, invalid/expired/revoked
credentials or deleted accounts 401. Account deletion removes receipts.

Keys share the account namespace with list creation and all four task write
operations. Another operation or normalized canonical body returns
`409 idempotency-conflict`. Title trimming and patch field order normalize; omitted
fields differ from explicit null or unchanged values. Preserve the exact UUID and
body after uncertain transport outcomes. The API performs no hidden observation,
retry, rebase or replanning; an intentional changed request needs a new key.

## Observed list deletion

Read `GET /api/v1/lists/{id}/deletion-observation`. Read tokens and Viewers may
observe. The envelope contains the strict existing ApiList `snapshot`, its scalar
`stateToken`, and `tasksState: { version: 1, count, token }`. The task SHA256 token
covers every persisted task column, including children and timestamp microseconds,
in ID order from one cursor snapshot. Scans use 256-row pages without a row limit;
a five-second cumulative scan deadline returns 503 instead of partial state.

`DELETE /api/v1/lists/{id}` requires a write token, current creator Member, Admin
or Owner authority, JSON content and a caller-owned UUID `Idempotency-Key`.
No query parameters are accepted; the complete UTF-8 body is limited to 4 KiB:

```json
{
  "workspaceId": "ORIGINAL_WORKSPACE_ID",
  "expectedState": "COPY_LIST_STATE_TOKEN",
  "expectedTasksState": { "version": 1, "count": 0, "token": "COPY_TASKS_TOKEN" },
  "cascadeTasks": false
}
```

False requires no tasks. True acknowledges deletion of all observed tasks and
their native dependent cascades. Changes to captured list scalars or task-table
state return `409 list-state-changed` before effects. Comments, assignees, labels,
history and attachments are not independently fingerprinted. Their current
contents follow native deletion rules: child tasks precede parents, committed
attachments are retired for garbage collection, pending transfers retain their
rows after parent removal, and retained import-history ledgers remain intact.
Pending import activation does not block authorized deletion. Workspace, folder,
keys and unrelated data are preserved. No blob I/O occurs in this transaction.

Native deletion and receipt commit atomically. Success and matching replay return
200 with `data: { kind: "list-delete-ack", snapshot: { ... }, deletedTasks: N }`.
The immutable original snapshot/count acknowledges that deletion and does not
assert current absence. Matching replay never deletes a replacement list. Replay
requires a live actor, valid write PAT and current authority in the original
workspace against its captured original owner. Missing original membership returns
404, insufficient roles/read tokens 403, and invalid or revoked credentials 401.

Keys share the account namespace with every list/task write; different operations
or canonical bodies return `409 idempotency-conflict`. Preserve the exact key and
body after an uncertain outcome. There is no automatic observation, retry or
replanning. Tokens describe semantic state, not monotonic revisions or durable
incarnations: an intentional fresh request can match identical recreation or ABA.

## Folders

`GET /api/v1/folders` and `GET /api/v1/folders/{id}` return strict folder records
with `id`, `workspaceId`, `name` and `sortKey`. Collection pagination and workspace
filters follow discovery rules. Read tokens and Viewers may read visible folders.
Folders grant no access; membership remains authoritative.

`POST /api/v1/folders` requires `{ "workspaceId": "WORKSPACE_ID", "name": "Projects" }`.
The server trims the name, requires 1-500 characters, rejects NUL/malformed Unicode,
and assigns a UUID and append order. No lists or access grants are created.

Read `GET /api/v1/folders/{id}/observation` before changing a folder. Its
`data.snapshot` is the existing strict folder record; `data.stateToken` is SHA256
of all four scalar fields in a version-1 canonical snapshot. This live read is not
a lock, monotonic revision or durable incarnation identity. Identical recreation
or semantic ABA may match an old token. Folder contents are outside this token.

`PATCH /api/v1/folders/{id}` accepts only:

```json
{
  "workspaceId": "ORIGINAL_WORKSPACE_ID",
  "expectedState": "COPY_OBSERVATION_STATE_TOKEN",
  "patch": { "name": "Projects" }
}
```

Rename follows native activation restrictions: a changed name with pending or
blocked import activation returns `409 activation-pending`; unchanged names may
succeed. IDs, workspace and order cannot be changed through this endpoint.

`DELETE /api/v1/folders/{id}` accepts `{ "workspaceId": "ORIGINAL_WORKSPACE_ID",
"expectedState": "COPY_OBSERVATION_STATE_TOKEN" }`. Only empty folders can be
deleted. Any list returns `409 folder-not-empty`; no cascade, reparenting, task
removal or orphaning occurs. Changed scalar state returns `409 folder-state-changed`.

All folder writes require JSON within 4 KiB, no query parameters, a write PAT,
current Member/Admin/Owner membership and a UUID `Idempotency-Key`. Authorization
and token validity are checked after native locks. Native mutation and receipt
commit atomically. Creation returns 201; updates, deletion and matching replay
return 200. Acknowledgements contain `kind` (`folder-create-ack`,
`folder-update-ack` or `folder-delete-ack`) and the immutable original `snapshot`.
They do not assert current existence or absence. Replay requires current authority
in the original workspace, never affects replacement IDs and shares the account
UUID namespace with all task/list writes. Different operations or canonical bodies
return `409 idempotency-conflict`. Preserve the same key/body after uncertain
outcomes; no automatic observation, retry or replanning occurs.

## Task creation

`POST /api/v1/tasks` requires a write token, `Content-Type: application/json`,
and a UUID `Idempotency-Key` header. The caller must be a Member, Admin, or Owner
in the target list's workspace. Viewer memberships cannot create tasks. No query
parameters are accepted, and the UTF-8 JSON body is limited to 64 KiB.

```json
{
  "listId": "LIST_ID",
  "title": "Buy coffee",
  "notes": "Ground coffee",
  "dueAt": "2026-10-03T17:00:00+02:00",
  "dueAllDay": false,
  "priority": 1,
  "assigneeIds": ["USER_ID"],
  "labelIds": ["LABEL_ID"]
}
```

Only `listId` and `title` are required. Title is trimmed and limited to 500
characters; notes are limited to 32,768 characters. `dueAt` is an ISO 8601 instant
with a timezone offset, or null. Resolve relative dates using the profile timezone
before submitting. `dueAllDay: true` requires a due instant. Priority is an integer
from 0 to 3. Assignees are up to 20 unique active workspace member IDs, and labels
are up to 50 unique IDs from the same workspace. Unknown fields and duplicate IDs
are rejected. Names, invitations, and access grants are not accepted implicitly.

Creation appends a top-level task to the list and returns the task envelope with
201. The task, assignments, labels, and request receipt commit together. Assignment
notification intents enqueue after commit, using the same semantics as browser
mutations; a crash between commit and enqueue can lose a notification.

Keep the UUID with the intended request until the result is known. Retrying the
same key and canonical payload returns 200 with the current authorized task,
without recreating it or sending another assignment notice. Omitted defaults,
equivalent due instants, and reordered assignee or label IDs canonicalize to the
same request. Reusing a key with a different payload returns 409. Keys are scoped
to the account, including across its tokens.

Deleting the task retains the receipt: a retry returns 410 and never recreates
the task while the original list remains visible. Inaccessible tasks or lists
return 404, and revoked credentials return 401. Account deletion removes receipts.
After a timeout or temporary 503, retry the same key and payload to avoid duplicates.

Errors use `application/problem+json` with stable `code`, `status`, `type` and
`title` fields. Invalid/expired/revoked tokens return 401, permission refusals 403,
invalid queries 400, rate limits 429 and temporary database contention 503.
Authenticated responses are marked `Cache-Control: no-store`.

## Task completion

`POST /api/v1/tasks/{id}/complete` requires a write token, a writable workspace
membership, JSON content and a UUID `Idempotency-Key`. No query parameters are
accepted. The JSON body is limited to 4 KiB and requires both fields:

```json
{ "listId": "LIST_ID", "expectedDueAt": null }
```

Copy `listId` and `dueAt` from the observed task. Supply its due instant as
`expectedDueAt`, or null when it has no due date. A changed list or due instant
returns 409 before completing anything. Recurring tasks advance through the same
completion path as the browser, including completion history and Karma. Habits
require their own occurrence workflow and are refused here. Imported tasks with
pending or blocked activation return `409 activation-pending` without effects.

The completion and account-scoped receipt commit together. Replaying the same
key and canonical body returns the current authorized task without advancing
another occurrence or awarding Karma again. Keys are shared with list creation and every task write;
reuse for another operation or body returns 409. A deleted task returns 410 while
its original list remains visible, or 404 when inaccessible. Read the task again
before intentionally completing its next occurrence with a new key.

## Scalar task updates

Read `GET /api/v1/tasks/{id}/observation` before editing. Read tokens and Viewer
memberships can observe visible tasks. Its envelope contains `data.snapshot` and
`data.stateToken`; existing task response schemas remain unchanged. The versioned
snapshot captures task/list/workspace IDs, title, notes, due instant, all-day flag,
priority, creation/completion state and recurrence evidence. Instants are normalized
to UTC milliseconds. The token is SHA256 of that canonical snapshot. It describes
only those fields, without locking a row or covering assignments, labels or other
relationships. It is not a monotonic revision: returning to the same scalar state
can produce the same token.

`PATCH /api/v1/tasks/{id}` requires a write token, current Member/Admin/Owner
membership, JSON content and a UUID `Idempotency-Key`. Supply the observed list and
token, and a nonempty patch:

```json
{
  "listId": "LIST_ID",
  "expectedState": "0000000000000000000000000000000000000000000000000000000000000000",
  "patch": { "title": "Buy coffee", "notes": null, "priority": 1 }
}
```

Replace the example token with `stateToken` from the observation. Accepted fields
are `title`, `notes`, `dueAt`, `dueAllDay` and `priority`, with the creation endpoint's
bounds and date format. Omitted fields preserve current values; null clears notes
or the due instant. The effective all-day flag requires a non-null due instant.
Unknown fields, empty patches and query parameters are rejected. The complete UTF-8
JSON body is limited to 64 KiB, including the observation and patch envelope.

Recurring tasks and habits permit title, notes and priority only. Any `dueAt` or
`dueAllDay` field returns `400 recurrence-workflow-required`, even if its value is
unchanged. Completion, moving, sorting, assignments, labels and recurrence rules
are separate workflows. Pending or blocked import activation returns
`409 activation-pending` before effects. A changed captured state or list returns
`409 task-state-changed`; read a new observation before intentionally submitting a
new update. Scope and membership refusals take precedence over stale-state errors.

The native mutation and receipt commit atomically. Same-key canonical replay
returns the current authorized task without applying the patch again, even after a
later edit. Current write access and writable membership are required for replay.
Keys share the account namespace with list creation and every task write; a different body or
operation returns `409 idempotency-conflict`. A deleted task returns 410 while its
original list remains writable and visible, or 404 when inaccessible. Revoked or
expired credentials return 401. Preserve the same key and body after an uncertain
transport result; no automatic retry or replanning occurs.

## Observed task deletion

Read `GET /api/v1/tasks/{id}/deletion-observation` with a read or write token.
Viewers may observe visible tasks. The envelope contains the existing scalar
`snapshot` and `stateToken`, plus `childrenState` with `version: 1`, `count` and
`token`. The child SHA256 token binds every persisted child task field, ordered by
ID, to the parent and origin list. A server cursor uses one snapshot and 256-row
pages; a five-second overall deadline refuses incomplete observations with 503.
The parent token retains the scalar scope described above. Tokens describe state,
not monotonic revisions. Related comments, assignments and files are not separately
observed: they belong to the explicitly acknowledged deletion scope.

`DELETE /api/v1/tasks/{id}` requires a write token, current writable origin-list
membership, JSON content and a UUID `Idempotency-Key`. No query parameters are
accepted. The complete UTF-8 body is limited to 4 KiB. All fields are required:

```json
{
  "listId": "LIST_ID",
  "expectedState": "COPY_PARENT_STATE_TOKEN",
  "expectedChildrenState": { "version": 1, "count": 0, "token": "COPY_CHILD_TOKEN" },
  "cascadeChildren": false
}
```

Copy the tokens and count from the deletion observation. `cascadeChildren: false`
requires no children. Set it to true only to acknowledge deletion of the exact
observed children and their dependent content. Parent scalar changes, moved tasks,
child additions/removals or any child task-field change return
`409 task-state-changed` before deletion. Read a new observation before submitting
an intentional new request; there is no automatic replanning.

Deletion uses the native task path: committed parent/child/comment attachments
are retired for garbage collection, and task dependencies follow their existing
cascade rules. Retained import-history replay ledgers remain intact. Pending import
activation does not block authorized deletion.

Success returns `data: { taskId, listId, deleted: true, deletedChildren }` with 200.
The deletion and receipt commit atomically. Matching replay returns the original
result without deleting a recreated task ID. Current write-token and origin-list
write authority are required even for replay. The origin list is identified by ID;
a recreated list with that ID follows current membership authority. Keys share the
account namespace with list creation and every task write; another operation or body
returns `409 idempotency-conflict`. Preserve the key and body after an uncertain
outcome. Missing/inaccessible origin lists return 404, viewers/read tokens 403,
and invalid, expired or revoked credentials and deleted accounts 401.

## Calendar download snapshot

`GET /api/v1/calendar.ics` requires a Bearer PAT with Read or Write access. Viewers
may export their visible tasks. Optional `workspaceId` and `listId` filters use
stable IDs from discovery; combined filters must refer to the same workspace.
Unknown, repeated and empty parameters are rejected. Missing/inaccessible filtered
resources return 404. Tokens in query parameters and browser cookies do not grant
access. This is a download snapshot, not a public URL or subscription capability.

Success is an attachment named `ditero-tasks.ics` with `text/calendar; charset=utf-8`,
`Cache-Control: no-store` and `nosniff`. Errors retain `application/problem+json`.
One database cursor snapshots authorized persisted tasks and the caller's timezone;
credentials, actor and exported-workspace membership are checked before release.

Each task is a VTODO with a deterministic opaque UID, snapshot DTSTAMP, title,
optional notes, completion status, priority, optional DUE and completion instant.
All-day DUE uses the caller's local Gregorian date; timed DUE and COMPLETED use UTC
seconds. TEXT values are escaped and Unicode lines fold at 75 UTF-8 bytes according
to [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545.html). No account identity,
assignees, credentials, attachment URLs or notification configuration is exported.

Recurring tasks and habits contribute only their current persisted task row.
No future instances, RRULE, alarms, habit logs or completion history are generated.
The snapshot does not schedule notifications or carry an update/replay identity.

The whole snapshot is limited to 10,000 tasks, 8 MiB of encoded output and 128 KiB
of combined title/notes UTF-8 text per task. Overflow returns
`422 calendar-too-large`; unsupported stored text returns `422 invalid-calendar-data`.
A five-second export deadline returns 503. No failure returns a partial calendar.
Use a narrower filter for a large snapshot. An authorized empty selection produces
a valid calendar with no VTODO components.

## Observed task relationship edits

`GET /api/v1/tasks/:id/relationships` returns `snapshot` with version 1, task,
list and workspace IDs, complete `assigneeIds` and `labelIds`, plus `stateToken`.
Read tokens and current Viewer members may observe. The token covers this scope
and these logical sets only; it does not cover scalar fields, label names,
comments, files or other dependent rows. Observation never truncates sets. A
five-second scan deadline, 50,000 evidence rows or 2 MiB evidence bound returns
an explicit refusal.

`PATCH /api/v1/tasks/:id/relationships` requires a write PAT and current Member+
authority. Send query-free JSON within 64 KiB, a UUID `Idempotency-Key`, and
`workspaceId`, `listId`, `expectedState`, `assigneeIds`, and `labelIds`. Both full
desired sets are required; empty arrays clear them. At most 20 unique active
workspace members and 50 unique same-workspace labels are supported. ID ordering
canonicalizes; duplicates, extra fields, stale observations, and cross-workspace
references are rejected. Pending import activation refuses assignment editing.
Native assignment/removal updates notification recipients; notices are collected
and enqueued after commit. Relationships and receipt commit atomically.

Success returns `task-relationships-update-ack` with the immutable original target
scope and sets. It does not claim that those sets remain current. After an uncertain
outcome, retry the identical body and key without replacing the token. A matching
receipt requires current original-workspace write authority and a valid write PAT;
it never edits a recreated task, reassigns a removed member, or sends another notice.
Keys share the account namespace with every other API write. Identical semantic
recreation can match a fresh request's state token. No invitations or label resource
creation, rename, recolor or deletion are provided by this endpoint.

## Calendar subscriptions

Account sessions manage calendar subscriptions through `GET /api/calendar-feeds`,
`POST /api/calendar-feeds` and `DELETE /api/calendar-feeds/:id`. Creation accepts
only `name`, `listId` and `expiresInDays` (1–365, default 90). There can be at most
20 active feeds per account. Viewer membership is sufficient. The server returns
a secret and relative `/api/v1/calendar-feeds/:secret/calendar.ics` path once.
Combine that path with your trusted configured server origin; it is a read-only
capability independent of personal access tokens. Treat the URL as a secret.
Metadata responses retain only its hint and never recover the URL. Listings return
up to 100 records, placing all active feeds before the newest expired/revoked history.

A feed stays bound to its original account, workspace and list. Downloads reject
query filters and validate the live account, current membership, list scope,
expiry and revocation, including empty lists. Revocation is immediate for later
requests. Snapshots use the existing iCalendar limits, date handling and escaping;
recurrence does not generate future instances. The feed includes task titles and
notes, so sharing its URL grants access to that list's exported task content.

## List-bound task webhooks

A write personal access token manages webhooks through `GET /api/v1/webhooks`,
`POST /api/v1/webhooks` and `DELETE /api/v1/webhooks/:id`. Cookie sessions are not
accepted. Creation accepts only `name`, `listId` and `expiresInDays` (1–365, default
90) and requires a non-viewer role in the list's workspace. An account can have at
most 20 active webhooks. The response returns the secret once and is never cached;
a retried create makes a new webhook. Listings return up to 100 metadata records
(hint, list, lifetime, revocation) and never the secret or any task data.
Revocation is idempotent and permanent.

A webhook can only create tasks in its original list. Send
`POST /api/v1/webhooks/:id/deliveries` with the secret in an
`Authorization: Bearer` header (never in a URL) and an `application/json` body of at
most 4 KiB: `deliveryId` (UUID), `title`, and optional `notes`, `dueAt`, `dueAllDay`
and `priority`, with the same limits and defaults as `POST /api/v1/tasks`. Unknown
fields, including assignees, labels, parents and list IDs, are rejected. Created
tasks have no assignees, labels or parent. The webhook secret is not a personal
access token and a personal access token is not a webhook secret.

`deliveryId` is unique per account. Repeating it with the same webhook and body
returns `200` with the original task ID and `replayed: true`; a new task returns
`201`. Reusing it with a different body, another webhook, or the task-create
endpoint returns `409`. If the task was deleted or moved out of the webhook's
list, a replay returns `410` with a fixed message that never names a new location.
The response contains only `id`, `listId` (the bound list) and `replayed`.

Every request, replays included, revalidates the webhook, the live account, the
membership and the list. Invalid, expired, revoked or mismatched credentials return
a uniform `401`; a demoted read-only role returns `403`; a missing list or membership
returns `404`. The route ID is matched case-insensitively; the secret decides.
Deliveries use their own rate limit bucket. Deleting an account removes its
webhooks.

A delivery or a webhook revoke can return `503 temporarily-unavailable` when it
waits more than one second for the account's row lock (for example during a burst of
deliveries). This is a temporary error, not a failure of the request: the server
never retries automatically. Retry a delivery with the **same** `deliveryId` so it
stays idempotent; a new `deliveryId` can create a second task.

The CLI (`list-webhooks`, `create-webhook --reveal-secret`, `revoke-webhook
--webhook UUID`) and the MCP tools `list_webhooks`, `create_webhook` and
`revoke_webhook` call these management endpoints with the configured write token.
They send no idempotency header or query string and never retry. Create and revoke
validate the response against the request; listing validates only the response
schema and its 100-row cap. `create_webhook` returns the one-time secret into the MCP
client's context, so prefer the CLI where that is not acceptable. Revocation can be
retried after a `503`. A creation is uncertain after a timeout, network failure,
cancellation, a 5xx server error, or an unreadable, oversized, redirected, non-JSON, invalid or
mismatched response: the webhook may exist while its secret is lost, so list webhooks
and revoke any unexpected one before creating again. Definite 400, 401, 403, 404, 409
and 429 errors keep their own codes without that advice.

## Observed task placement

Read `GET /api/v1/tasks/{id}/placement-observation` for the original scalar task,
parent ID, ordering key, list snapshot and complete child-state token/count. Read
the existing target-list observation explicitly; its token is `expectedTargetState`.
For ordering within the original list, use the embedded list snapshot to derive
the same canonical list observation token, or read that list observation explicitly.

`PATCH /api/v1/tasks/{id}/placement` requires a write PAT, Idempotency-Key and
strict JSON bounded to 4 KiB: `workspaceId`, original `listId`, `expectedState`,
`targetListId`, `expectedTargetState`, `sortKey`, `cascadeChildren`, and
`expectedChildrenState`. Ordering requires false/null; root relocation requires
true and the exact observed child token/count, including an empty child set.
Keys are valid opaque fractional keys, 2-256 ASCII characters; callers choose the
key, and no sibling ordering or neighbor revision is implied.

Only same-workspace, same-kind lists are supported. Subtasks can reorder within
their list; moving a root relocates its existing children without changing their
keys. Changing parents, converting list kinds or moving between workspaces is
excluded. Recurrence, completion history and attachment/key identities are
preserved; native notification recipient reconciliation still applies.
Changed task/list/child observations refuse before effects. Pending import
activation refuses. No hidden observations, retries or new request IDs occur.

The immutable `task-place-ack` includes original scope, moved-child count and actual
resulting task/list/workspace, ordering key and parent ID. Exact replay acknowledges
that original result without mutating a recreated task or revalidating a current
target. Current original-workspace write authority and a live valid write PAT are
required. Legacy scalar task update and its live replay contract remain unchanged.

## Task comments

`GET /api/v1/tasks/{id}/comments` lists full comment snapshots in ID order.
Current members, including Viewers, may read. `limit` defaults to 50 and is at
most 100; `cursor` is bound to this task. Unknown or repeated queries are refused.
Snapshots expose author, body, scope, timestamps and historical author display
metadata. Import source namespaces, row IDs and principal IDs stay private.
A complete page envelope above 256 KiB is refused without truncation; reduce the
page size or observe an oversized comment individually.

`GET /api/v1/tasks/{id}/comments/{commentId}/observation` returns `snapshot` and
`stateToken`. The compact body contains `sha256` and `utf8Bytes`. The token binds
every stored comment field, including private provenance and timestamp
microseconds, to its task/list/workspace. Tokens describe semantic state, not
monotonic revisions or durable incarnations; identical recreation can match a
fresh request. The observation takes no query parameters and makes no mutation.

All writes require a live write PAT, JSON content, no query parameters and a
caller-owned UUID `Idempotency-Key`. Supply the original `workspaceId` and
`listId`. Creation uses `POST /api/v1/tasks/{id}/comments` with
`expectedTaskState` copied from the existing task observation and `body`.
Creation preserves exact whitespace, permits an empty string and follows the
native 10,000-character limit. The complete fatal UTF-8 transport envelope is
bounded to 64 KiB. The server assigns the comment UUID on the first committed
attempt. Current Member/Admin/Owner membership is required.

Editing uses `PATCH /api/v1/tasks/{id}/comments/{commentId}` with `expectedState`
from the comment observation and `body`. Only its native author with current
write membership may edit. Imported comments cannot be edited. Native edit has
no character cap; the complete transport envelope remains bounded to 64 KiB.
Body whitespace is preserved. Author, task and provenance cannot be changed.
Pending import activation does not block these native comment operations.

Deletion uses `DELETE /api/v1/tasks/{id}/comments/{commentId}` with `expectedState`
and `deleteScope: "comment-and-attachments"` in a body bounded to 4 KiB. The native
author with write membership or a current Admin/Owner may delete. Imported or
null-author comments require Admin/Owner. Committed comment attachments retire
for garbage collection; no blobs are erased in this transaction. Current related
attachments follow native rules and are not covered by the comment state token.

Authority and captured scope/state are checked under native locks before effects.
Stale state returns `409 comment-state-changed`. Mutation and immutable receipt
commit together. Success returns `comment-create-ack`, `comment-update-ack`, or
`comment-delete-ack`, with original workspace/list/task scope and the original
snapshot. Create/update retain the complete bounded body; delete retains compact
body evidence and `deleted: true`. Replay still requires live credentials and
current original-workspace authority against its captured original author/import
status, even if the task/list/comment is gone or recreated. Replay does not read
or mutate replacements or assert current existence/absence. Missing original
membership returns 404, insufficient authority/read PAT 403, invalid PAT 401.
Account deletion removes receipts.

Creation reuses native lexical mention parsing and current-member name matching,
including all name collisions and excluding the author. Mentions grant no access
and create no invitation. Creation events enqueue after commit on the existing
best-effort path; a crash in that gap may lose a notice. Edits, deletes, matching
replays and rolled-back mutations emit no mention event. Acknowledgments do not
claim notification delivery.

UUID keys share the account namespace with every other API write. Different
operations or exact canonical bodies return `409 idempotency-conflict`. Preserve
the identical key, body and observation after uncertain transport. No hidden
observation, invitation, retry, rebase or replanning occurs.

The source CLI exposes `list-task-comments`, `observe-comment`, `add-comment`,
`edit-comment` and `delete-comment`; all require explicit `--task`, and item
operations also require `--comment`. Writes take the strict JSON bodies above
on stdin and require `--request-id`. Comment pages support only explicit
limit/cursor and never `--all`. The matching MCP tools are `list_task_comments`,
`get_comment_observation`, `create_task_comment`, `update_task_comment` and
`delete_task_comment`. Mutation inputs use a strict `comment` object and explicit
`requestId`, task and comment IDs. Both clients validate typed scope/body/kind
acknowledgments and bounded task-bound pages without hidden reads or retries.
See [CLI](../cli.md#task-comments) and [MCP](../mcp.md#task-comments) for examples.
