# Public API

The versioned API provides discovery, idempotent list and task creation, scalar
updates, observed task completion and deletion, and authenticated iCalendar
snapshots. Public calendar subscriptions and webhooks remain under development.
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
creation semantics), and `completedDisplay` (`sink`, `keep`, `hide`). Omitted fields
preserve values. ID, workspace, owner, kind, folder and order are immutable through
this endpoint. Unknown fields, NUL, malformed Unicode and invalid enums are refused.
After native authority/container locks, a different captured scalar state returns
`409 list-state-changed` without mutation. Changed metadata on lists with pending or
blocked import activation returns `409 activation-pending`; an unchanged patch can
succeed. Authority refusals take precedence over stale state.

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
