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
Text uses the terminal's existing background, including light or dark themes.
Cyan identifies navigation and the selected row, which also has a `>` marker.
Selected semantic cues remain bold; completed titles are dim when unselected.
Task titles stay neutral. Red marks overdue or high-priority cues, yellow medium
priority, blue low priority, green completed checkboxes and magenta recurrence.
Set `NO_COLOR` or pass `--no-color` for plain text. Priority words, due labels and
round open/done markers remain visible without color. Pass `--ascii` for ASCII
frames and `( )`/`(x)` markers without a special font. Arabic text needs suitable
terminal font and shaping support.

Task rows include available due dates, priority, recurrence, quantity and assignment
or label counts. At 100 columns they use a dense row; at 60 columns metadata uses
a second line; at 40 columns only the selected row expands. Details show returned
identifiers rather than guessing names or subtask totals. Dates use the account
timezone and locale; creation reviews use the timezone captured by their planner.
The start view shows a static FIGlet-style ASCII wordmark and the actual client
version and reported API/locale settings beside it on a sufficiently wide, tall
terminal. It needs no FIGlet runtime or
additional font. The status bar reports only the loaded page's open, done and
overdue counts. It does not claim a global total or sync status. Breadcrumbs use
names already loaded during navigation. The API access label reports the profile's
token scope; server authorization still governs every request.

Use arrows and Enter to browse workspaces, lists, tasks, people, labels, views,
dashboards and folders. Escape returns to the previous surface. Press `p` for the next page
and `r` to restart the current collection. Task and configuration details scroll
with Up, Down, Home and End. A scroll cue appears inside clipped details or help
and remains visible after scrolling. Help wraps at word boundaries and Esc returns.
Back, quit and open take priority in narrow footers;
`?` includes the global navigation, exit and symbol hints. Press `?` for help and
`q` to quit. Ctrl-C always
restores the terminal and exits, including during requests.

Press `n` on a selected list or dashboard, or inside a list's tasks, to add a task.
Enter its title, press Enter, then enter `today`, `tomorrow`, `YYYY-MM-DD`, or leave
the due day empty. Dates use the chosen account timezone and server time; date-only
tasks resolve at local noon. Dashboard creation is refused if its writable backing
list is ambiguous or the proposal does not match its task panels. Habits require
explicit scheduling and are refused by this ordinary task workflow. Use the
[CLI planner](cli.md#plan-and-create-a-task) for explicit assignees, labels and
dashboard backing-list selection.

The review shows a readable summary, the endpoint and its request UUID. An
already loaded list name appears alongside its canonical ID, including in the
task-list header; no additional lookup
is made. Human fields come first; request metadata and unset values are dim.
NOT SENT uses a warning cue; an unconfirmed result uses a danger cue. Press `v`
to switch between the summary and exact request payload, including omitted fields
and explicit null values. `v` also switches task details to their exact returned
data. Scroll to inspect the whole proposal and press `y` to send. The screen
distinguishes a request not yet sent from an unconfirmed result. `?` opens help;
`y` cannot submit while help is open. Pasting `y` never confirms an action. Press
`c` on a task to review completion. Recurring completion advances the observed
occurrence through the normal server recurrence, history and Karma path.
A changed occurrence requires refreshing and reviewing again.

Press `e` on a task to fetch an explicit scalar observation and open the editor.
Fields start with the observed values. Backspace edits the current field; Enter
advances through title, notes, due instant, all-day flag and priority, then opens
review. Only changed fields enter the patch. Notes preserve existing newlines and
accept multiline bracketed paste. Empty edited notes clear them. Due values use
ISO 8601 with a timezone, such as `2026-10-04T12:00:00+02:00`; empty clears the due
instant and all-day flag. Type `0` or `1` for all-day, and `0` through `3` for
priority. Due fields are unavailable for recurring tasks and habits. Escape cancels
before sending. No changed fields means no request.

Press `d` to obtain a deletion observation. Type `1` to delete without children
(available only when the observed child count is zero), or `2` to include all
observed children, then Enter to review. The readable review repeats this captured
choice and its observed child count before sending. The deletion also includes dependent
comments, assignments and files and cannot be undone. Only typed `y` submits the
review; pasted choices or confirmations never submit. A changed scalar or child
state returns a conflict. Refresh and explicitly observe again before preparing a
new request; the client never rebases a patch or cascade choice automatically.

Writes are never retried automatically. An uncertain write keeps its exact UUID
and body for an explicit `r` retry. `y` sends only a request that has not been sent;
it is ignored after an uncertain result. Escape cannot discard an uncertain
request. The client does not replan relative dates or
generate a new UUID for that retry. If you quit before the result is confirmed,
stderr prints a JSON retry record with `requestId`, `endpoint` and `body`, after
restoring the terminal. Update and deletion records also include `method` (`PATCH`
or `DELETE`); existing creation/completion records use POST. This record contains
task content; keep it private. Submit
it to the same server with an authorized token for the same account through the
documented public API.
Do not use a new UUID to retry an unconfirmed operation.

The interface is an online API client. Authorization refusal clears protected
rows and proposals; it never falls back to cached private content. Requests and
responses use the CLI's time and size limits. A collection has at most 100 pages
and 20 MiB; refresh starts a fresh bounded collection. Pages reflect current
server rows rather than an atomic snapshot. Reordering and other metadata workflows remain separate API/client work.
After a successful write the collection refreshes. A deletion replay acknowledges
the original deletion and does not prove that a recreated ID is currently absent.
