# Public API

The versioned API provides discovery and idempotent task creation. Other task
writes, iCal feeds, webhooks and terminal write commands remain under development.
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
