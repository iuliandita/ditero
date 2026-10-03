# Ditero CLI

The CLI uses the version 1 public API to discover member-visible content, plan a
task, and create it with an explicit retry key. Packaged CLI releases are not
available yet.

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

Discovery and creation success print `{ "version": 1, "data": ..., "nextCursor": ... }` to stdout.
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
| 10 | Request ID already used for a different task |
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

Both commands accept JSON stdin up to 64 KiB with strict UTF-8, bounded nesting,
prototype-key rejection, and unknown-field rejection. They do not accept file
paths, collection filters, credentials as flags, or automatic retry options.
Planning ambiguity errors include `choices` in the JSON error envelope.
