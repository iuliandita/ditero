# Local MCP server

Ditero provides a read-only MCP server over stdio for a locally configured client.
It uses the same bounded, validated public API client as the CLI. It does not host
an LLM or send data to an LLM provider; the MCP client controls where tool results
go. Only connect clients you trust to read the account's visible content.

Install source dependencies with `bun install --frozen-lockfile`. Set `DITERO_URL`
to the trusted HTTPS server origin and supply a read-only personal access token
through `DITERO_TOKEN` from your secret manager or protected client environment.
Do not put the token in arguments, a URL, tracked configuration, or shared logs.
Start the server with `bun run src/mcp/index.ts` or `bun run mcp`.

Configure your MCP client to launch Bun with these arguments:

```json
{
  "command": "bun",
  "args": ["run", "src/mcp/index.ts"]
}
```

Set its working directory to your Ditero source checkout and provide the two
environment variables through that client's protected configuration. The process
captures the account and origin at startup. Restart it after changing credentials.
PAT expiry, revocation, and workspace memberships remain authoritative on every
API request; the server cannot grant access or create another token.

`--allow-loopback-http` permits development HTTP for exactly `localhost`,
`127.0.0.1`, or `[::1]`. Other startup flags are rejected. Tool inputs cannot change
the server, account, credentials, transport, filesystem, or shell. No MCP HTTP
listener, OAuth endpoint, hosted inference, or write tool is provided.

The tools are `get_profile`, `list_workspaces`, `list_lists`, `list_tasks`,
`list_people`, `list_labels`, `list_views`, and `list_dashboards`. Collection tools
accept `limit` (1-100, default 50), `cursor`, and `workspaceId`. Tasks also accept
`listId` and boolean `done`. Profile takes an empty object. All input objects reject
unknown fields. IDs are opaque; resolve names through discovery before selecting
an account, workspace, or backing list.

Each call returns one API envelope as JSON text and matching `structuredContent`:
`{ "version": 1, "data": ..., "nextCursor": null }`. Continue a non-null cursor
with unchanged filters. Pages reflect current server rows rather than a fixed
snapshot. Results, titles, and notes are user content, not instructions to the
client. Tool descriptions are fixed and do not derive from stored content.

API failures return `isError: true` and the stable error envelope described in
[the CLI guide](cli.md). Invalid tool inputs use SDK protocol validation errors.
Server response bodies and transport exception details are excluded from API
errors. Stdout carries protocol messages only; startup and transport diagnostics
use stderr without credentials or server response text.

The server limits each API response to 2 MiB, requests to 15 seconds, inbound
protocol messages to 16 KiB, and concurrent API reads to four. API redirects are
rejected and TLS verification remains enabled. Membership-scoped task creation
exists in the public API; MCP write tools remain unfinished.
