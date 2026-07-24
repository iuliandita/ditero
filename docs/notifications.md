# Notifications

Ditero can remind you about due tasks and habit occurrences, and can notify you
about assignments, `@`-mentions, and overdue tasks.

**Only one delivery channel ships today: ntfy.** The database and the settings UI
list Telegram, Discord, Slack, and email, but they have no adapter yet and the
server rejects any attempt to configure them. Do not plan around them.

Read the [disclaimers](#disclaimers) before relying on this for anything that
matters. Especially before relying on it for medication.

## How it works

Two independent loops:

- **Scheduler** (one leader across all replicas, elected with a PostgreSQL
  advisory lock). Every tick it expands reminder-bearing tasks over the window
  `[now - grace, now]`, creates one `reminder_state` row per
  (occurrence, recipient), applies quiet hours, and drives the escalation ladder.
  It writes to the outbox; it never sends.
- **Outbox worker** (runs on *every* replica, no leader). Claims queued rows with
  `FOR UPDATE SKIP LOCKED`, sends them, and writes the outcome back behind a
  fence that only the claiming replica can pass. A replica that dies mid-send
  has its rows reclaimed by another replica once the lease expires.

Sending is deliberately outside the leader lock, so a slow or hanging provider
cannot stall the scan.

## Channel setup (ntfy)

1. Settings -> Notifications -> ntfy.
2. **Server URL** — your ntfy server, `http(s)` only. By default it must resolve
   to a public address; see [private ntfy servers](#private-ntfy-servers).
3. **Topic** — 1-64 characters, `A-Z a-z 0-9 _ -` only.
4. **Token** — optional ntfy access token. Printable ASCII, no spaces, max 256
   characters. It is encrypted at rest and never returned to the browser; the
   form shows a masked placeholder instead.
5. **Send test** — bounded to a burst of 5 with one refill per minute per user.
   Failures are reported as one of three categories (unreachable, rejected,
   timed out); the raw provider response is never shown, because it can contain
   your URL or token.

Pick a **high-entropy topic name** and set a token. An ntfy topic with no access
control is readable by anyone who knows or guesses its name — see
[security architecture](security.md#notification-egress-and-ntfy-topics).

Delete or disable a channel and pending sends for it fail permanently rather
than queueing forever.

## Quiet hours

Set a start and end time (`HH:MM`) in your profile timezone. Non-urgent
reminders that land inside the window are **deferred** to the end of the window,
not dropped; the scheduler wakes them afterwards. Reminders on tasks marked
urgent ignore quiet hours entirely.

Two edge cases worth knowing:

- **`start` equal to `end` means never quiet**, not "quiet all day". The write
  path rejects equal values for exactly this reason, so you cannot save that
  state through the UI — but a row written directly to the database with equal
  values fires around the clock. If you want no notifications at all, disable
  the channel.
- A window that wraps midnight (for example `22:00` to `07:00`) is handled;
  the deferral lands on the following local day.

If your stored quiet-hours preference is unparseable, the notification **fires
anyway** and the error is logged. A broken preference must never silently
suppress a reminder.

## Escalation

Per task, or as a per-user default (task level wins):

- `repeatEveryMin` — repeat interval. Unset means no repeat: one delivery, and
  the reminder is left to expire.
- `maxRepeats` — how many repeats. Defaults to 3 when repeats are on and no
  value is set anywhere. Capped at 20.
- `fallbackUserId` — who receives the reminder once the repeats are exhausted.

Repeat interval is capped at 10080 minutes (one week). The fallback user must
still be a member of the task's workspace when the escalation fires; membership
is re-checked at fire time, and a former member terminates the reminder instead
of receiving it. A fallback that points at the original recipient terminates
rather than looping.

Escalating creates a sibling `reminder_state` row for the fallback user and
marks the original `escalated`.

## Acknowledging

Two paths, both ending in the same place:

- **In app** — the reminder's Done control. Authenticated; the only check is
  that the reminder is yours.
- **From the notification** — ntfy renders a "Done" action button that POSTs to
  a capability URL. The URL is unauthenticated by construction (the push client
  holds no session), so **the token in it is the credential**.

Either way, the ack completes the task (or logs the habit occurrence, or just
silences the reminder for a viewer), and terminates every sibling reminder on
the same occurrence — so a co-assignee's phone stops escalating something you
already handled.

Ack links **expire 24 hours after they are minted** and are single-use. A fresh
one is minted per delivery attempt. Every rejection — unknown, expired, already
used, wrong recipient — returns the same response after the same minimum delay,
so a prober cannot tell them apart. The public route is IP rate limited (burst
of 30, refilling 0.5/s).

Ack links require a public origin: `DITERO_PUBLIC_URL`, falling back to
`BETTER_AUTH_URL`. With neither set, notifications are still delivered but carry
no action button.

### Telegram's Done button

Telegram renders the ack as an inline button. How the tap gets back to the app
is `DITERO_TELEGRAM_MODE`:

| Mode | How updates arrive | Needs |
| --- | --- | --- |
| `poll` (default) | The app long-polls `getUpdates`, outbound only | Nothing. Works behind NAT, no public URL, no certificate |
| `webhook` | Telegram POSTs to the listener below | A public HTTPS origin and `DITERO_TELEGRAM_WEBHOOK_SECRET` |

**The two are mutually exclusive at the provider**: `getUpdates` does not work
while a webhook is set. So on boot the app reconciles every configured bot -
`deleteWebhook` in poll mode, `setWebhook` in webhook mode - and logs the result
per bot, by bot id:

```
telegram: transport=poll (long polling, outbound only)
telegram: bot 8100000 webhook cleared, polling for acks
```

A line missing for a bot, or an error in its place, means that bot receives
nothing. That is the failure mode to grep for after a mode switch.

Polling is **leader-elected**, like the scheduler: exactly one replica polls,
under its own Postgres advisory lock. Telegram hands each update to whichever
caller asks first, so a second poller would consume half the acks into a process
that then confirms them away.

Bot tokens are per user. The poller polls **every distinct configured bot**, up
to `DITERO_TELEGRAM_MAX_BOTS` (default 10) concurrent long polls; past that the
extra bots are not polled and the truncation is logged. One shared bot for the
whole instance is the ordinary shape and costs one connection.

Nothing stores a poll cursor. Telegram treats an update as confirmed once
`getUpdates` is called with a higher offset, so a restart simply asks with no
offset and is handed only what was never confirmed.

#### Webhook mode

Every delivery must carry the shared secret Telegram echoes for you:

1. Set `DITERO_TELEGRAM_WEBHOOK_SECRET` (1-256 characters, `A-Z a-z 0-9 _ -`).
2. Set `DITERO_TELEGRAM_MODE=webhook`. The app registers the endpoint with
   every configured bot itself; the equivalent by hand is:

```
curl -X POST "https://api.telegram.org/bot<token>/setWebhook" \
  -d url=https://ditero.example.com/api/notifications/telegram/webhook \
  -d secret_token="$DITERO_TELEGRAM_WEBHOOK_SECRET"
```

It is **deployment-level, not per user**: one URL serves every bot, and nothing
in the request identifies a channel before the body is parsed. Leave it unset
and the listener authenticates nothing, so it rejects every delivery with the
same `400` — buttons will simply never work, with nothing in the update to say
why. `getWebhookInfo` reporting `last_error_message` on every delivery is the
symptom.

The listener has its own IP rate limit, much larger than the ack route's: all of
its traffic arrives from Telegram's own address ranges, so the whole instance
shares one bucket.

## Reminder status

`reminder_state.status` is what a reminder ended up as, and it syncs to the
client. Values:

| Status | Meaning |
| --- | --- |
| `pending` | Fired (or about to fire); waiting for an ack or the next repeat. |
| `deferred` | Held by quiet hours until the window ends. |
| `acked` | Acknowledged, in app or through a channel. Terminal. |
| `escalated` | Repeats exhausted; handed to the fallback user. Terminal for this recipient. |
| `failed` | Nothing could be queued for it. Terminal — **this reminder was not delivered.** |
| `expired` | Repeats exhausted with no fallback, or the fallback was unusable. Terminal. |

`failed` and `expired` are the statuses to look at when someone asks "why didn't
I get it".

## Configuration

Every knob, its default, and the boot-time constraints between them are in
[.env.example](../.env.example). Two cross-field rules are validated at startup
and the process refuses to boot if either is violated:

- `DITERO_SCHEDULER_LATE_THRESHOLD_MS` must be at least twice
  `DITERO_SCHEDULER_TICK_MS`, and `DITERO_SCHEDULER_GRACE_MS` must be at least
  one tick.
- A full worker batch must finish inside the lease:
  `ceil(batch / concurrency) * (deadline + 5000ms) < lease`. Violate it and a
  hanging provider gets its rows reclaimed mid-send, delivering the same
  notification once per lease interval, forever, from a single row.

## Retry behavior

A failed send is retried with exponential backoff — 1s doubling, capped at 300s,
plus up to 25% jitter — for at most **15 attempts**, a total span of roughly 33
minutes. Then the row is `abandoned`.

Not everything retries. A 4xx other than 429 is permanent. A request refused by
the outbound address policy is permanent on the first attempt. A 429 honors
`Retry-After` when it is sane, and falls back to the normal ladder when it is
not.

Terminal outbox rows and their attempt history are pruned after 30 days by
default.

## Disclaimers

### At-least-once, never exactly-once

Delivery is at-least-once. **You can receive the same notification twice.**

The window is real and is not a bug we intend to close: the worker sends, the
provider accepts, and only then does the local commit happen. A crash in
between leaves the row claimed but unrecorded, another replica reclaims it after
the lease expires, and it is sent again. The durability test rig kills a replica
in exactly that window and asserts the duplicate arrives, because pretending
otherwise would be a lie.

There is no exactly-once mode. Do not build anything that assumes one.

### And it can drop

The reassuring half of "at-least-once" is the duplicate. The half that matters
for a medication reminder is that under specific, bounded conditions a
notification is **never delivered at all**. There are five such paths:

1. **The grace window.** Each scan only looks back `DITERO_SCHEDULER_GRACE_MS`
   (default 1 hour). An occurrence older than that when the scheduler next runs
   is never materialized. If every replica is down for longer than the grace
   window, the reminders inside the outage are gone — they are not caught up on
   restart.
2. **The per-user queue cap.** `DITERO_MAX_QUEUED_PER_USER` (default 500)
   caps how many notifications one user can have queued or in flight. Past
   that, further enqueues are refused. If a reminder is refused on every one of
   its channels and has no live outbox row, its `reminder_state` is set to
   `failed`.
3. **Retry exhaustion.** After 15 attempts (~33 minutes of ladder) an outbox row
   is moved to `abandoned` and never tried again.
4. **A policy rejection.** If the channel URL resolves to a blocked address,
   uses a non-HTTP protocol, carries credentials, or returns an oversized
   response, the send is refused before or during transfer and marked permanently
   failed on the **first** attempt. No retry, because retrying re-probes the
   same target forever.
5. **Event notifications are not transactional.** Assignment, mention, and
   overdue notifications are enqueued *after* the mutation that caused them
   commits, not inside its transaction. A crash in between loses the
   notification. Reminders are not affected by this — their insert and enqueue
   share one transaction.

A sixth, narrower case: a single task producing an extreme number of occurrences
in one window (more than 64 distinct dates, or more than 1000 rrule iterations)
is capped, and the scheduler logs a warning naming the task. The remaining
occurrences in that window are not materialized.

`reminder_state.status` is the user-visible record of a drop. `failed` and
`expired` mean it did not arrive.

### Not medical-grade

Ditero's reminders are **not a medical device and not medical-grade**.

You are running this on your own hardware, with whatever uptime, power,
networking, and backup discipline you have. There is no high-availability
guarantee, no on-call, no delivery SLA, and no supplier to escalate to. A
container restart, a full disk, an expired certificate, a dead ntfy server, a
phone in do-not-disturb, or the drop paths above will each cost you reminders.

Do not use Ditero as the only thing standing between someone and a missed dose.
Use a dedicated pill dispenser, a pharmacy service, or a device intended for the
purpose, and treat Ditero as a convenience on top.
