# Public API

The versioned API currently provides read-only discovery. Task writes, iCal feeds,
webhooks and terminal clients remain under development. Write tokens reserve a
permission ceiling for future write operations; they do not grant workspace access.

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

Errors use `application/problem+json` with stable `code`, `status`, `type` and
`title` fields. Invalid/expired/revoked tokens return 401, permission refusals 403,
invalid queries 400, rate limits 429 and temporary database contention 503.
Authenticated responses are marked `Cache-Control: no-store`.
