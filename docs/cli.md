# Ditero CLI

The read-only CLI uses the version 1 public API. It reads the signed-in account's
profile and member-visible workspaces, lists, tasks, people, labels, views, and
dashboards. Writes and packaged CLI releases are not available yet.

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

Every success prints `{ "version": 1, "data": ..., "nextCursor": ... }` to stdout.
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
