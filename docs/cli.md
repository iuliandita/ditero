# Ditero CLI

The CLI uses the version 1 public API to discover member-visible content, plan a
task, create it, and complete, update, or delete an observed task with an explicit retry key.
Later sections cover list, folder, comment, relationship, placement and webhook workflows.
A local Linux x64 glibc standalone candidate can be built for all three terminal
clients. Public binary distribution is blocked while embedded runtime license and
copyright notices remain incomplete in [#575](https://github.com/iuliandita/ditero/issues/575).
Neither release assets nor public Actions uploads include these executables.

```sh
bun install --frozen-lockfile
bun run build:clients
./out/clients/ditero-VERSION-clients-linux-x64/bin/ditero --version
```

`BUILDINFO.json` records the release version, base source commit, official Bun
runtime revision and checksum, target, and `runtimeNoticesComplete: false`.
Modified local source is marked separately. Runtime qualification passes on Linux
x64 glibc in Ubuntu 24.04 without Bun or a checkout; this does not qualify binary
redistribution. SSE4.2 is required. ARM, musl, Windows and macOS remain unqualified.
Automatic `.env`, `bunfig.toml`, `package.json` and `tsconfig.json` loading is disabled.
Supply credentials explicitly through the process environment. Caller-controlled
Bun runtime flags are trusted configuration; the executable is not a sandbox.
Bundled relink inputs and partial notices are retained in the local candidate.

The [terminal interface](tui.md) provides interactive browsing and reviewed task
creation, completion, scalar updates, deletion and reordering, plus read-only
comments, through the same public API.

Install the repository dependencies with `bun install --frozen-lockfile`, then run
`bun run cli --help`. This source CLI requires Bun. Configure `DITERO_URL` with an
HTTPS server origin and provide a personal access token through `DITERO_TOKEN`
from your secret manager or shell environment. The CLI does not store credentials
or accept a token argument. Use a read-only token for discovery. The `folders` command reads member-visible
folder records with the same pagination and workspace filters as other collections.

```sh
bun run cli profile --json
bun run cli workspaces --json
bun run cli tasks --workspace WORKSPACE_ID --list LIST_ID --done false --limit 100 --json
bun run cli lists --cursor NEXT_CURSOR --json
bun run cli people --all --json
bun run cli labels --json
bun run cli views --json
bun run cli dashboards --json
```

`--server https://todo.example.com` overrides `DITERO_URL`. Only an origin is
accepted: credentials, paths, query strings, and fragments are rejected. For local
development, `--allow-loopback-http` permits HTTP for exactly `localhost`,
`127.0.0.1`, or `[::1]`. Redirects are rejected and TLS verification stays enabled.

Discovery and write success print `{ "version": 1, "data": ..., "nextCursor": ... }` to stdout.
`--json` produces one compact JSON line; otherwise JSON is indented. Collections
default to 50 items, with `--limit` from 1 to 100. Pass the opaque `nextCursor` as
`--cursor` with the same filters to continue. A null cursor ends the collection.
`--workspace` works on discovery collections; task comment pages accept only task,
limit and cursor. `--list` and `--done` apply only to tasks.
Profile takes no collection options.

`--all` collects up to 100 pages and 20 MiB before printing. Each response is
limited to 2 MiB and each request times out after 15 seconds. Invalid data, repeated
cursors, and exceeded bounds fail without printing partial results. Continue large
collections manually with cursors. Pagination reflects current server rows and
does not provide a consistent snapshot while other clients change data.

Errors go to stderr. With `--json`, they use
`{ "version": 1, "error": { "code": "...", "status": null, "message": "..." } }`.
HTTP errors include their numeric status; local errors use null. Server response
bodies and transport exception text are never copied into error messages. Requests
are not retried automatically.

| Exit | Meaning |
| --- | --- |
| 0 | Success |
| 2 | Invalid arguments, configuration, or rejected request |
| 3 | Invalid, expired, or revoked token |
| 4 | Permission denied |
| 5 | Missing resource or API |
| 6 | Rate limit reached |
| 7 | Network, timeout, or response stream failure |
| 8 | Invalid response, size bound, or pagination bound |
| 9 | Other HTTP or internal failure |
| 10 | Request conflict or stale observed state |
| 11 | Original task deleted; retry cannot recreate it |

## Plan and create a task

`plan-task` reads one strict JSON task intent from stdin. A model or caller turns
natural language into explicit intent first: "tag Alex" is ambiguous, so choose
whether Alex is an assignee or a label. Assignees and labels are separate arrays
of `{ "id": "..." }` or `{ "name": "..." }` selectors. Mentions, invitations,
access grants, and arbitrary natural-language input are not implemented by task planning.

For example, "buy coffee tomorrow in my private Inbox and assign Alex" becomes:

```sh
bun run cli plan-task --json <<'JSON'
{
  "title": "Buy coffee",
  "target": { "kind": "list", "selector": { "name": "Inbox" }, "personal": true },
  "due": { "day": "tomorrow" },
  "assignees": [{ "name": "Alex" }]
}
JSON
```

Targets can be a `list` or `dashboard`. A dashboard is a surface over backing
lists, so creation always needs one writable backing list. Set `target.listId`
when multiple lists qualify. The `personal: true` selector expresses private
intent: it permits only the caller's personal backing lists, and for dashboards
also requires a caller-owned personal dashboard. It does not change permissions.
Duplicate names return an error with authorized ID/name choices; select a known
ID and plan again. Missing people are refused without sending invitations.
Habit destinations are refused because an ordinary task intent does not request
a habit schedule. The shared creation path defaults top-level habits to daily
recurrence, which this workflow must not choose implicitly.

The planner reads the account profile and all pages of workspaces, lists, people,
labels, views, and dashboards sequentially. The combined context is capped at
20 MiB; each collection is capped at 100 pages. Any failed page, missing view,
ambiguous destination, or dashboard filter mismatch produces no partial output.
These reads are not an atomic snapshot; the server revalidates current authority
when creating the task.

`due.day` accepts `today`, `tomorrow`, or `YYYY-MM-DD`; optional `due.time` uses
`HH:MM`. A dated task requires a chosen account timezone. Relative days use the
server profile time and that timezone, including daylight saving transitions.
Date-only tasks resolve at local noon with `dueAllDay: true`. The result contains
`version`, `target`, `timezone`, `resolvedAt`, and the canonical API `task` object.
Planning never creates a task. Use a write token to plan and create.

`create-task` accepts only the API task object on stdin, not the whole plan or
natural-language intent. Pass a UUID with `--request-id`. Preserve both this UUID
and the exact canonical task proposal until the outcome is known. For example,
a previously resolved proposal can be submitted as:

```sh
bun run cli create-task --request-id 00000000-0000-4000-8000-000000000001 --json <<'JSON'
{
  "listId": "LIST_ID",
  "title": "Buy coffee",
  "notes": null,
  "dueAt": "2026-10-25T11:00:00.000Z",
  "dueAllDay": true,
  "priority": 0,
  "assigneeIds": ["ALEX_ID"],
  "labelIds": []
}
JSON
```

Replace the example IDs, resolved date, and request UUID with the reviewed
proposal and its own explicit key. Creation sends one POST and returns the
current authoritative server task for either 201 creation or 200 replay. A
network failure can leave the result uncertain. Retry with the same UUID and
proposal; do not resolve "tomorrow" again or generate a new UUID for that retry.
A 409 means that UUID belongs to another payload; a 410 means its original task
was deleted and will not be recreated. Neither failure retries automatically.

Task workflow commands accept JSON stdin up to 64 KiB (deletion: 4 KiB) with strict UTF-8, bounded nesting,
prototype-key rejection, and unknown-field rejection. They do not accept file
paths, collection filters, credentials as flags, or automatic retry options.
Planning ambiguity errors include `choices` in the JSON error envelope.

## Complete an observed task

Inspect the task first, then supply its observed list ID and due instant. Use
`null` only when the inspected task has no due date. `complete-task` accepts
exactly these two fields on stdin and requires both task ID and a request UUID:

```sh
bun run cli complete-task --task TASK_ID --request-id 00000000-0000-4000-8000-000000000002 --json <<'JSON'
{ "listId": "LIST_ID", "expectedDueAt": "2026-10-25T11:00:00.000Z" }
JSON
```

Completion sends one POST without discovery or automatic retries. A recurring
task advances the inspected occurrence; its returned task can remain incomplete
with a new due date. A stale observation returns 409. After an uncertain result,
retry with the identical task ID, completion body, and UUID. Never read a newer
due date or generate another key for that retry. A deleted original task returns
410. Completion requires current write authority. `--task` is accepted only by
task workflows and comment commands; discovery filters are rejected on these commands.

## Update an observed task

`observe-task --task TASK_ID` reads the live scalar snapshot and opaque `stateToken`.
Inspect it, then pass the observed list ID and token in a strict scalar patch:

```sh
bun run cli observe-task --task TASK_ID --json
bun run cli update-task --task TASK_ID --request-id 00000000-0000-4000-8000-000000000003 --json <<'JSON'
{ "listId": "LIST_ID", "expectedState": "OBSERVED_STATE_TOKEN", "patch": { "title": "Reviewed title", "notes": null } }
JSON
```

Replace the placeholders with the actual observation and a caller-chosen UUID.
Allowed patch fields are `title`, `notes`, `dueAt`, `dueAllDay`, and `priority`.
Omitted fields remain unchanged; explicit null clears notes or dueAt. Dates are
normalized to UTC. Recurring tasks and habits accept title, notes, and priority
only; due-field changes require a separate recurrence workflow. The observation
is a live read of scalar state, not a lock or relationship revision.

Update sends one PATCH. A stale state returns 409 before effects. Same-key replay
returns the current authorized task, so it can include a later edit; it never
reapplies the patch. If the original task was deleted, replay returns 410.

## Delete an observed task

`observe-task-deletion --task TASK_ID` additionally returns `childrenState`:
version, count, and a token covering every persisted child task field. Inspect
both the parent and children, then explicitly choose the cascade scope:

```sh
bun run cli observe-task-deletion --task TASK_ID --json
bun run cli delete-task --task TASK_ID --request-id 00000000-0000-4000-8000-000000000004 --json <<'JSON'
{ "listId": "LIST_ID", "expectedState": "OBSERVED_STATE_TOKEN", "expectedChildrenState": { "version": 1, "count": 0, "token": "OBSERVED_CHILDREN_TOKEN" }, "cascadeChildren": false }
JSON
```

False requires no children. True deletes the exact observed children and their
dependent content, including comments, files, and assignments. Related content
is covered by this explicit scope rather than the child token. Parent or child
changes return 409. The DELETE body is limited to 4 KiB. Success returns the
original deletion acknowledgment with `taskId`, `listId`, `deleted`, and
`deletedChildren`; replay returns that acknowledgment even if the ID is recreated
and does not delete the recreated task.

Observation commands need a read token and accept no stdin or collection flags.
Update and deletion need current write authority. Each write requires an explicit
request UUID, shared account-wide with create and completion. Neither command
performs a hidden observation or retries. After an uncertain result, preserve and
explicitly retry the identical task ID, body, and key. Do not fetch replacement
tokens or mint a new key for that retry.


## Create and update lists

`create-list` reads the strict API list object from stdin and requires an explicit
UUID. The API assigns ID, owner, root append position and defaults; it creates no
invitations, access grants or tasks. Choose workspace and kind explicitly:

```sh
bun run cli create-list --request-id 00000000-0000-4000-8000-000000000005 --json <<'JSON'
{ "workspaceId": "WORKSPACE_ID", "title": "Groceries", "kind": "shopping", "icon": null }
JSON
bun run cli observe-list --list LIST_ID --json
bun run cli update-list --list LIST_ID --request-id 00000000-0000-4000-8000-000000000006 --json <<'JSON'
{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "expectedState": "OBSERVED_STATE_TOKEN", "patch": { "title": "Reviewed title", "icon": null, "completedDisplay": "hide" } }
JSON
```

Replace IDs, token and UUIDs with explicit reviewed values. `observe-list` performs
one GET without reading stdin or accepting a request UUID. Read tokens and Viewers
may observe. Its strict snapshot covers every ApiList scalar field: ID, workspace,
owner, title, kind, icon, folder, sort order and completed-display policy. The
semantic token is not a lock, monotonic revision or durable incarnation identity;
identical state, including identical recreation, may match again. Relationships
are outside the token.

List writes accept at most 4 KiB of fatal UTF-8 JSON before any network request,
with prototype/unknown-field rejection. Title is trimmed, 1-500 characters; icon
is null or at most 128 characters; completedDisplay is sink, keep or hide. Kind is
required on creation. Update accepts a nonempty patch of title, icon, completedDisplay, folderId and
sortKey; omission preserves values. It cannot change ID, workspace, owner or kind. Supply the original workspace and observed token.

Creation sends one POST and returns `list-create-ack`; update sends one PATCH and
returns `list-update-ack`, each containing the immutable original snapshot. Matching
replay retains that snapshot after later edits/deletion/recreation and never mutates
a replacement. Use a separate observation for current state. Both writes require
current write PAT and writable original-workspace membership, including replay.

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

A 409 is an explicit conflict, with no hidden read, new observation, retry or rebase.
Preserve the exact UUID, list ID and canonical body after an uncertain response,
then manually retry those values. An intentional changed request needs a new UUID.
Keys share the account namespace with all list/task writes. Collection flags,
credentials as flags and file paths are refused on these commands.


## Observed list deletion

Inspect the complete deletion observation, then choose the task cascade explicitly:

```sh
bun run cli observe-list-deletion --list LIST_ID --json
bun run cli delete-list --list LIST_ID --request-id 00000000-0000-4000-8000-000000000007 --json <<'JSON'
{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "expectedState": "OBSERVED_STATE_TOKEN", "expectedTasksState": { "version": 1, "count": 0, "token": "OBSERVED_TASKS_TOKEN" }, "cascadeTasks": false }
JSON
```

Replace the IDs, tokens, count and UUID with reviewed values. Observation sends
one GET without stdin or a request UUID. Read tokens and Viewers may observe.
The strict response contains the original ApiList snapshot, scalar stateToken,
and tasksState covering every persisted task column, including children. Tokens
are semantic evidence, not locks or incarnation identities; identical recreation
may match a fresh request again.

Deletion accepts one strict UTF-8 JSON body within 4 KiB and sends one DELETE.
False requires zero tasks. True accepts deletion of all observed tasks and native
dependent cleanup of comments, assignees, labels, history and committed attachment
retirement. These dependents are not independently fingerprinted. Pending transfers
retain native behavior; the command performs no blob I/O or key deletion. Current
write PAT and original-workspace list creator, Admin or Owner authority are required,
including replay. Changed scalar or task state returns 409 without a hidden read,
retry, replacement token or automatic rebase.

Success returns immutable `list-delete-ack` with the original snapshot and exact
`deletedTasks` count. It does not claim current absence. Matching replay returns
that acknowledgement without deleting a recreated list. Request UUIDs share the
account-wide list/task write namespace. After cancellation or an uncertain response,
manually retry the identical list ID, original workspace, body and UUID; never
substitute fresh state or a new key for that retry.


## Observed task assignments and labels

Inspect the current relationship observation, then provide both complete desired ID sets:

```sh
bun run cli observe-task-relationships --task TASK_ID --json
bun run cli update-task-relationships --task TASK_ID --request-id 00000000-0000-4000-8000-000000000008 --json <<'JSON'
{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "listId": "ORIGINAL_LIST_ID", "expectedState": "OBSERVED_STATE_TOKEN", "assigneeIds": ["MEMBER_ID"], "labelIds": ["LABEL_ID"] }
JSON
```

Replace IDs, token and UUID with reviewed values. Observation sends one GET without
stdin or a request UUID. Read tokens and Viewers may observe. The strict response
contains versioned task/list/workspace scope, complete assigneeIds and labelIds,
and a semantic stateToken. Complete observations can exceed the write limits;
they are never silently truncated. The token covers scope and relationship sets,
not scalar task fields, label names, comments or attachments. Identical state,
including recreation, may match a fresh request again.

Replacement sends one PATCH with strict fatal UTF-8 JSON within 64 KiB. Both arrays
are required; [] explicitly clears a set. Up to 20 unique assignees and 50 unique
labels are accepted, duplicates refused and desired sets sorted canonically.
Assignees must be current original-workspace members and labels must belong to
that workspace. Use people/label discovery to select IDs explicitly; the command
does not resolve names, invite members or create, rename, recolor or delete labels.
Pending notification activation can refuse assignment editing. Current write PAT
and original-workspace Member, Admin or Owner authority are required, including
replay. Collection flags and credential overrides are refused.

Success returns immutable `task-relationships-update-ack` with the original scope
and exact canonical desired sets. It does not claim current relationships. Matching
replay never edits a recreated task or duplicates assignment notices. A 409 remains
an explicit conflict without hidden reads, merging, retries or replacement tokens.
UUIDs share the account-wide task/list write namespace. Cancellation or a lost
response can leave a committed result uncertain; manually retry the identical task
ID, original scope, full body and UUID, without fetching replacement evidence or
minting a new UUID for that retry.

## Observed task ordering and relocation

`observe-task-placement --task TASK_ID` reads one complete placement observation.
`place-task --task TASK_ID --request-id UUID` accepts strict JSON on stdin:

```json
{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "listId": "ORIGINAL_LIST_ID", "expectedState": "TASK_PLACEMENT_TOKEN", "targetListId": "TARGET_LIST_ID", "expectedTargetState": "TARGET_LIST_TOKEN", "sortKey": "a1", "cascadeChildren": false, "expectedChildrenState": null }
```

Supply the target token from a separate explicit list observation. Ordering in the
current list requires false/null. Relocating a root to another same-workspace,
same-kind list requires true and the complete observed children object
`{ "version": 1, "count": 0, "token": "CHILDREN_TOKEN" }`, including when empty.
Children move with the root and retain their ordering keys. Subtasks can only be
ordered in their current list; reparenting, workspace moves and kind conversion
are excluded. Sort keys are opaque validated fractional keys, never repaired or
regenerated. Sibling ordering is not guarded.

Each operation sends one request; the write is bounded to 4 KiB before sending.
There are no hidden reads or retries. Write PAT and current original-workspace
write authority remain required, including replay. Changed observations return
409. Success returns immutable `task-place-ack` with original scope, resulting
snapshot and movedChildren count, rather than claiming current state. Replay
never moves a recreated task. After an uncertain outcome, manually retry the
identical task ID, full body and UUID; do not substitute fresh observations or a
new key. UUIDs share the account-wide task/list write namespace.

## Task comments

`list-task-comments --task TASK_ID` reads one page, default 50 and maximum 100.
Use `--limit` and the returned task-bound `--cursor` explicitly; `--all`, workspace
filters and list filters are refused. The complete response is bounded to 256 KiB
without truncation. Read tokens and current members, including Viewers, may read.

```sh
bun run cli list-task-comments --task TASK_ID --limit 50 --json
bun run cli observe-task --task TASK_ID --json
bun run cli add-comment --task TASK_ID --request-id 00000000-0000-4000-8000-000000000010 --json <<'JSON'
{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "listId": "ORIGINAL_LIST_ID", "expectedTaskState": "TASK_STATE_TOKEN", "body": "  Reviewed comment\n" }
JSON
bun run cli observe-comment --task TASK_ID --comment COMMENT_ID --json
bun run cli edit-comment --task TASK_ID --comment COMMENT_ID --request-id 00000000-0000-4000-8000-000000000011 --json <<'JSON'
{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "listId": "ORIGINAL_LIST_ID", "expectedState": "COMMENT_STATE_TOKEN", "body": "  Updated comment\n" }
JSON
bun run cli delete-comment --task TASK_ID --comment COMMENT_ID --request-id 00000000-0000-4000-8000-000000000012 --json <<'JSON'
{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "listId": "ORIGINAL_LIST_ID", "expectedState": "COMMENT_STATE_TOKEN", "deleteScope": "comment-and-attachments" }
JSON
```

Replace IDs, observation tokens and UUIDs with reviewed values. Both reads make
one GET without stdin or UUID. Comment observation contains compact body evidence
`{ "sha256": "...", "utf8Bytes": 0 }`; its semantic token covers all stored fields,
hidden provenance and precise timestamps. It is neither a lock nor durable
incarnation identity. Oversized native comments can still be observed and deleted.

Writes preserve exact whitespace, including empty bodies. Creation follows the
native 10,000-character limit; editing has no character cap. Both JSON envelopes
are bounded to 64 KiB with fatal UTF-8 validation. Deletion is bounded to 4 KiB
and requires explicit comment-and-attachments scope; committed files retire for
garbage collection. Only the native author with current write membership may edit.
Deletion permits that author or Admin/Owner; imported/null-author comments require
Admin/Owner. Creation-only lexical mentions notify current members after commit
on a best-effort basis without invitations or access grants. Editing emits no
mention event. Acknowledgments do not promise delivery.

Each write sends one POST, PATCH or DELETE without hidden observations or retries.
Success returns the immutable original acknowledgment, even after deletion or ID
recreation, and replay never changes a replacement. Current original-workspace
authority remains required. UUIDs share the account namespace with all API writes.
After uncertain transport or cancellation, manually retry identical task/comment
IDs, body and UUID; never replace the observation or generate a new key. A 409
remains actionable. Inspect a separate observation for current state.

## Webhooks

`list-webhooks`, `create-webhook` and `revoke-webhook` manage list-bound task
webhooks with a write token from `DITERO_TOKEN`. They take no request ID, paging,
filters or retries, and send no idempotency header.

```sh
bun run cli list-webhooks --json
bun run cli create-webhook --reveal-secret --json <<'JSON' > webhook.json
{ "name": "Inbox", "listId": "LIST_ID", "expiresInDays": 90 }
JSON
bun run cli revoke-webhook --webhook WEBHOOK_UUID --json
```

Listing sends one GET without query parameters and returns up to 100 metadata
records, active first, never a secret. Creation reads one strict JSON object of at
most 4 KiB (`name` 1–80 characters, `listId`, optional `expiresInDays` 1–365,
default 90). The secret is shown once and cannot be fetched again, so
`--reveal-secret` is required: without it the command exits 2 before reading input
or contacting the server. The secret is printed only on stdout, in the single JSON
result; redirect it to a protected file or secret manager, and never to a shared
log. Errors on stderr never contain it. Creation sends one POST and never retries.
Once it is sent, the outcome is uncertain after a timeout or network failure
(`network_error`, exit 7), cancellation (`cancelled`, exit 7), a 5xx server error
(`temporarily_unavailable` for 503, otherwise `http_error`, exit 9), and a response that cannot be read, is
oversized, redirected, not JSON, invalid (`invalid_response`, exit 8) or does not
match the request: the webhook may exist but the secret is discarded. List webhooks
and revoke any unexpected one before creating again. Each creation makes another
webhook, up to 20 active. Definite errors keep their own codes and exit codes and
carry no such advice: 400 `request_rejected`, 401 `unauthorized`, 403 `forbidden`,
404 `not_found`, 429 `rate_limited`, and a 20-webhook limit as `webhook_limit`
(exit 10).

Revocation sends one DELETE for the lowercase-normalized UUID, without a body, and
accepts only an acknowledgement whose ID matches the request. It is idempotent and
permanent, so an uncertain outcome or a temporary 503 (`temporarily_unavailable`,
exit 9) can be retried safely. Listing validates only the response schema and its
100-row cap.

## Observed folder workflows

`observe-folder --folder FOLDER_ID` reads one live folder snapshot and stateToken,
without stdin or a request UUID. Read tokens and Viewers may observe member-visible
folders. Semantic tokens are not locks or incarnation identities.

Write commands require a write token, `--request-id UUID`, and one strict JSON
object on stdin within 4 KiB:

- `create-folder`: `{ "workspaceId": "WORKSPACE_ID", "name": "Projects" }`.
- `update-folder --folder FOLDER_ID`: `{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "expectedState": "OBSERVED_STATE_TOKEN", "patch": { "name": "Renamed" } }`.
- `delete-folder --folder FOLDER_ID`: `{ "workspaceId": "ORIGINAL_WORKSPACE_ID", "expectedState": "OBSERVED_STATE_TOKEN" }`.

Names are trimmed and must contain 1-500 characters. Creation assigns the ID and
append position on the server. Updating changes only the name; pending import
activation can refuse changed names. Deletion requires an empty folder and never
cascades, reparents, or deletes lists/tasks. Stale state and nonempty deletion return
409 (exit 10). Discover explicit IDs through `folders`; workflows do not resolve names.

Each operation sends one request without hidden observation, automatic retry or
rebase. Writes return immutable `folder-create-ack`, `folder-update-ack` or
`folder-delete-ack` snapshots. Replay retains the original result after deletion or
recreation and does not touch replacements or claim current existence/absence.
Current original-workspace Member/Admin/Owner authority and a valid write PAT are
required on every write, including replay. Cancellation or lost transport may leave
a committed result uncertain. Manually retry only the identical folder ID, full
canonical body and UUID; never substitute fresh observations or a new key. UUIDs
share the account-wide task/list/comment/folder write namespace.

### Optional starter setup

`ditero setup-status --json` reads the versioned setup status without changing content. An older server returning 404 produces `data: null`, meaning the capability is unavailable. Other errors retain their normal error codes. Discovery is bounded to 1.5 seconds and 16 KiB.

`profile` may print a localized starter suggestion on stderr for a pending, eligible account. JSON stdout stays unchanged. The link always uses the configured server origin and `/setup`. No browser opens, and discovery failure does not block normal operations.
