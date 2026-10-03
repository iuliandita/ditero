# Ditero terminal interface

The [local Linux x64 standalone candidate](cli.md) includes `bin/ditero-tui`. Run
`bin/ditero-tui --version` to inspect its build identity, then launch it in an
interactive POSIX terminal. Bun and a source checkout are not required. The same
commands below work with `bin/ditero-tui` in place of `bun run tui`. Automatic
local config loading is disabled; set the process environment explicitly.
Binary publication remains blocked by incomplete runtime notices. Other platforms
and architectures remain unqualified.

Run `bun install --frozen-lockfile`, then `bun run tui --help`. Set `DITERO_URL`
to the server HTTPS origin and `DITERO_TOKEN` through your secret manager or
environment. Tokens are never command-line arguments or stored by this client.
This source interface requires Bun and an interactive POSIX terminal.

```sh
bun run tui
bun run tui --server https://todo.example.com --locale ro
```

For local development, `--allow-loopback-http` permits HTTP only for `localhost`,
`127.0.0.1` or `[::1]`. Redirects are refused and TLS verification remains enabled.
The account locale is used unless `--locale en|de|es|fr|ro|ar` overrides it.
Text uses the terminal's existing foreground and background, including light or
dark themes. Arabic text needs a terminal with suitable font and shaping support.

Use arrows and Enter to browse workspaces, lists, tasks, people, labels, views and
dashboards. Escape returns to the previous surface. Press `p` for the next page
and `r` to restart the current collection. Task and configuration details scroll
with Up, Down, Home and End. Press `?` for help and `q` to quit. Ctrl-C always
restores the terminal and exits, including during requests.

Press `n` on a selected list or dashboard, or inside a list's tasks, to add a task.
Enter its title, press Enter, then enter `today`, `tomorrow`, `YYYY-MM-DD`, or leave
the due day empty. Dates use the chosen account timezone and server time; date-only
tasks resolve at local noon. Dashboard creation is refused if its writable backing
list is ambiguous or the proposal does not match its task panels. Habits require
explicit scheduling and are refused by this ordinary task workflow. Use the
[CLI planner](cli.md#plan-and-create-a-task) for explicit assignees, labels and
dashboard backing-list selection.

The review shows the resolved task and its request UUID. Scroll to inspect the
whole proposal and press `y` to send. Pasting `y` never confirms an action. Press
`c` on a task to review completion. Recurring completion advances the observed
occurrence through the normal server recurrence, history and Karma path.
A changed occurrence requires refreshing and reviewing again.

Writes are never retried automatically. An uncertain write keeps its exact UUID
and body for an explicit `y` retry. The client does not replan relative dates or
generate a new UUID for that retry. If you quit before the result is confirmed,
stderr prints a JSON retry record with `requestId`, `endpoint` and `body`, after
restoring the terminal. This record contains task content; keep it private. Submit
it to the same server with an authorized token for the same account through the
documented public API.
Do not use a new UUID to retry an unconfirmed operation.

The interface is an online API client. Authorization refusal clears protected
rows and proposals; it never falls back to cached private content. Requests and
responses use the CLI's time and size limits. A collection has at most 100 pages
and 20 MiB; refresh starts a fresh bounded collection. Pages reflect current
server rows rather than an atomic snapshot. Reordering and metadata editing
remain separate API/client work.
