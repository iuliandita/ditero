# Ditero CLI

The CLI uses the version 1 public API to discover member-visible content, plan a
task, create it, and complete, update, or delete an observed task with an explicit retry key.
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

The [terminal interface](tui.md) provides interactive browsing, reviewed creation
and completion through the same public API.

Install the repository dependencies with `bun install --frozen-lockfile`, then run
`bun run cli --help`. This source CLI requires Bun. Configure `DITERO_URL` with an
HTTPS server origin and provide a personal access token through `DITERO_TOKEN`
from your secret manager or shell environment. The CLI does not store credentials
or accept a token argument. Use a read-only token for discovery.

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
`--workspace` works on every collection; `--list` and `--done` apply only to tasks.
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
access grants, and arbitrary natural-language input are not implemented.

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
task observations, `complete-task`, `update-task`, and `delete-task`; discovery filters are rejected on these commands.

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
required on creation. Update accepts a nonempty patch of only title, icon and
completedDisplay; omission preserves values. It cannot change ID, workspace,
owner, kind, folder or order. Supply the original workspace and observed token.

Creation sends one POST and returns `list-create-ack`; update sends one PATCH and
returns `list-update-ack`, each containing the immutable original snapshot. Matching
replay retains that snapshot after later edits/deletion/recreation and never mutates
a replacement. Use a separate observation for current state. Both writes require
current write PAT and writable original-workspace membership, including replay.

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
