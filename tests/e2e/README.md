# Browser tests

The test web server closes each API HTTP response when `NODE_ENV=test` and
`DITERO_E2E_SIGNUP_TRANSPORT=1`. This prevents signup setup from inheriting an
earlier request's idle connection, including an API GET from another context.
The proxy preserves this contract when upstream responses advertise keep-alive.
Frontend documents and assets retain connection reuse during page startup.
Normal development and production keep their existing connection behavior.
The API fixture also closes each HTTP response when `NODE_ENV=test` and
`DITERO_E2E=1`, including the separate SMTP origin used for direct API signup.
Interrupted requests still fail, and signup POSTs are not retried.

Run the suite with `bun run test:e2e`. Filters and Playwright flags are forwarded:

```sh
bun run test:e2e dashboards --project=chromium-serial
```

The `chromium` project contains isolated suites that can run with two workers.
`chromium-serial` contains suites that share database or server state and must run
with one worker. Firefox and WebKit retain the cross-engine crypto-vector cases.
Per-file ordering is preserved in both Chromium projects. Combined runs default
to one worker; enable two workers only for the isolated phase.

CI runs three shards, each with two sequential phases. Run the same phases locally
in Bash or zsh by setting `E2E_SHARD` to 1, 2, or 3:

```sh
export E2E_SHARD=1
PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/reports/isolated.json \
  bun run test:e2e --project=chromium --project=firefox --project=webkit \
  --workers=2 --shard="$E2E_SHARD/3" --fail-on-flaky-tests \
  --reporter=list,json --output=test-results/isolated
case "$E2E_SHARD" in
  1) serial_specs=(tests/e2e/ack-live.spec.ts tests/e2e/auth-hardening.spec.ts tests/e2e/channels.spec.ts tests/e2e/dashboards.spec.ts) ;;
  2) serial_specs=(tests/e2e/domain.spec.ts tests/e2e/e2e-invite-fragment.spec.ts tests/e2e/navigation.spec.ts) ;;
  3) serial_specs=(tests/e2e/notifications.spec.ts tests/e2e/sharing.spec.ts tests/e2e/spine.spec.ts) ;;
  *) echo "Unknown E2E_SHARD: $E2E_SHARD" >&2; exit 1 ;;
esac
PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/reports/serial.json \
  bun run test:e2e "${serial_specs[@]}" --project=chromium-serial --workers=1 \
  --fail-on-flaky-tests --reporter=list,json --output=test-results/serial
```

The isolated phase uses Playwright sharding. The serial phase selects whole files
explicitly: its three groups contain 25, 33, and 21 cases, with historical test
work of 223.1, 327.6, and 234.2 seconds respectively. These groups balance total
runner time against the isolated phase; count-based serial sharding left one
runner on the critical path. They preserve all 79 serial cases without splitting
file ordering or running serial suites concurrently.

Run the second phase even if the first fails. Each invocation creates and removes
a fresh test stack. CI shards run on separate hosted runners. The separate output
directories and JSON reports preserve evidence from both phases; CI uploads
`test-results/` for each shard with a seven-day retention period.

## Per-run isolation and cleanup

The integration S3 fixture uses pinned SeaweedFS 4.48 in standalone server mode.
The historical service names `minio` and `minio-init`, volume `minio-data`, port
9000, and `DITERO_TEST_MINIO_PORT` remain compatible with the runner. Its static
`seaweedfs-s3.json` contains dummy `minioadmin` credentials used with the `ditero-test`
bucket in this disposable fixture. The health check makes an authenticated
S3 request; the initializer uses the built-in administrative shell to create the
bucket if absent. Only S3 is published to loopback; internal administrative ports
stay on the test network. Growth allocates one volume per request so bucket and
metadata collections share the four-volume ceiling. Both services run as UID/GID
1000 with bounded resources.
These credentials and storage settings are not deployment guidance.

Every runner invocation generates a UUID and uses the Compose project
`ditero-e2e-<uuid without dashes>`. The label `io.ditero.e2e.run=<uuid>` is on
every Compose service, all three named volumes, and the default network. Compose
files default the label to `unmanaged`, which is what the integration runner
(`ditero-integration`, unchanged) gets. The runner forces Docker-assigned
loopback ports for the database, Zero, and browser; it reads the exact
`127.0.0.1:<port>` bindings from Compose and refuses anything else. The API,
mail API, web, SMTP, SMTP-HTTP, and ntfy ports are reserved together on ephemeral
sockets (ntfy on the private interface, the rest on loopback), released
afterwards, and must differ from each other and from the Docker ports. Web
runs with `--strictPort` and Playwright never reuses a server, so losing a
reservation race fails the run. `TRUSTED_ORIGINS` follows the web origin. The Vite
`/api` proxy follows `E2E_API_URL` only when `NODE_ENV=test` and the value is a
plain loopback `http:` origin; otherwise it stays `http://localhost:3000`.
Outside the runner, `bunx playwright test` keeps the old fixed ports. The
isolated browser endpoint is set only after the owned browser's actual port is
discovered. Compose defaults stay fixed for the integration runner (database
55432, Zero 4849, browser 53000, API 3000).

Cleanup never runs `docker compose down`, `--remove-orphans`, `--force`, or a
project-wide delete. Before the first `up` the runner checks that nothing carries
its project or marker. After each `up`, including a failed or interrupted one, it
records the full ID, creation time, and labels of what Docker created. At cleanup
it queries every container, volume, and network that has this project label or
this marker, and validates all of them before any write:

- containers: full 64-hex ID, exact project and marker, service `upstream-db` or
  `zero-cache` (`browser` only with `E2E_BROWSER_CONTAINER=1`);
- volumes: exactly `<project>_postgres-data`, `<project>_zero-data`, or
  `<project>_minio-data`, with the
  Compose volume label, project, and marker;
- network: full ID, exactly `<project>_default`, Compose network label `default`,
  project, and marker.

Any other related resource -- the same project with a missing or different marker,
the marker under a different project, a wrong service, a mismatched name or label,
or an identity that changed since it was recorded -- makes the runner **refuse**.
It then removes nothing, prints the offending short IDs (never environment
values), and exits nonzero. If no `up` was ever started, any related resource is
likewise refused. An empty inventory is a safe no-op.

When the inventory is valid, each resource is inspected again immediately before
its write and must still match. Writes are exact and non-forced, bounded by
timeouts: `docker stop --time 10 <full ID>`, `docker rm <full ID>` (no `-f`, no
`-v`), `docker volume rm <name>`, `docker network rm <full ID>`, in that order.
The first failed recheck or command stops all later writes; nothing is retried.
The first test, setup, or signal error is kept as the exit status; diagnostics and
cleanup errors are printed separately, and a cleanup failure turns an otherwise
successful run nonzero.

A refused or partial cleanup leaves the stack in place. Inspect it by marker
(the runner prints the run ID), and remove it by hand only after confirming the
resources are yours:

```sh
docker ps -a --filter label=io.ditero.e2e.run=<uuid>
docker volume ls --filter label=io.ditero.e2e.run=<uuid>
docker network ls --filter label=io.ditero.e2e.run=<uuid>
docker ps -a --filter label=io.ditero.e2e.run   # any run, e.g. a killed runner
```

A runner killed with `SIGKILL` leaks its stack; the next run does not reap it.
Postgres data uses the marked named `postgres-data` volume mounted at
`/var/lib/postgresql`; cleanup validates and removes that exact owned volume.

Before cleanup after a failed test or setup step, the runner saves bounded,
timestamped Compose logs without color, container status/state, and one resource snapshot
under `<output>/stack-diagnostics/`. It selects only this test project's containers
and does not inspect their environment. The destination follows Playwright's
`--output` argument (default `test-results`); `E2E_OUTPUT_DIR` overrides it.
Diagnostic commands have a 15-second limit each, and failures are reported without
changing the original test failure or preventing stack cleanup. CI uploads these
files alongside the phase's browser evidence.

Dashboard sharing failures also attach scoped account, membership, and dashboard
state, sanitized sync metadata tagged by scenario account role, and a read-only
snapshot of the scenario accounts' saved query records. Each owner, member,
outsider, and viewer page is observed before signup, with at most 100 events per
page. The snapshot includes query versions and expected root/witness reference
counts for at most four recovered client groups and the scenario's known row keys.
Recovery uses the actual account-specific dashboard and preference query
transformation hashes. It records partial, deleted, ambiguous, and truncated
candidates; only a unique active double match selects a group. Browser observations
corroborate recovery but do not widen its scope. Each candidate or saved-query
result has a 200-row limit; truncation is explicitly flagged.
It excludes credentials, query arguments, and row contents.

After the original member or viewer dashboard-visibility assertion fails and its
state is captured, a five-second observer opens one new context for that same
account with cookies only and empty origin storage. It records whether the Team
entry appears without changing preferences or retrying the failed assertion.
A secondary snapshot selects the explicit new WebSocket client group only when
its account-specific named-query transformations match. It compares up to four
original groups plus that one proven fresh group, retaining the original failure.
The new context closes in a finally block; diagnostic errors cannot replace the
original error.

The runner also supplies its exact Compose arguments through
`E2E_DIAGNOSTIC_COMPOSE_ARGV`. On a sharing failure, the capture reads the active
Zero container's serving path from a bounded worker startup log, then verifies
WAL2 using its native SQLite consumer in a read-only transaction. Backup-enabled
workers serve `replica.db-serving-copy`; the collector never selects a path by
file existence. It verifies a native online backup against the pinned snapshot
metadata and removes that temporary full snapshot before returning scoped data.
It selects only versions, expected root/witness keys, and dashboard
visibility predicates for at most four accounts, two dashboards, five workspaces,
and eight memberships. A container-side hard kill bounds Node to four seconds,
with a five-second host deadline and 32-KiB output cap; startup log inspection
has a separate two-second deadline and returns no raw logs;
errors omit stderr and never replace the test assertion. Direct Playwright runs
without the runner hook report replica capture as unavailable.

Replica capture precedes the CVR snapshot. Compare their timestamps, state and
replica versions, saved-row versions, and connection cookies before attributing a
missing dashboard to query evaluation or catchup. These are independent committed
snapshots, not an atomic capture or a ViewSyncer's earlier held transaction.

Routine authenticated fixtures use context-bound API signup with UUID addresses
under the reserved `example.test` domain, then wait for the real workspace to sync.
They do not depend on signup-form interaction. Dedicated registration, refusal,
and locale tests still exercise the real form. Use the shared fixture helpers
rather than timestamp addresses or another signup wrapper.

The October 1 CI optimization in issue #381 used a historical baseline of 230
browser cases (216 Chromium, 7 Firefox, and 7 WebKit). Its candidate added two
public Zero shutdown regressions for 232 total cases, with 139 isolated and 79
serial Chromium cases. Acceptance required three complete workflows at the same
candidate commit, each within 18 minutes 20 seconds, preserving the baseline and
executing every candidate case without skips or retry-only passes. Those counts
and timing requirements applied to that candidate; they are not current suite
counts or a general acceptance policy for later changes. The shutdown tests
continue to cover accepted edits, persistence failure, explicit retry, and offline
cache recovery.

Current CI runs six browser phases across three shards and requires the aggregate
`verify` job to pass. Its gates include checks, integration, browser tests, all
three container smokes, and push-relay verification, including native relay instance
integration and relay image checks. Use the current suite discovery and workflow
reports to verify coverage. A green label check or discovery-only run does not
prove execution.

For hosts where Docker interface changes interrupt Chromium requests with
`net::ERR_NETWORK_CHANGED`, isolate the browsers in a container:

```sh
E2E_BROWSER_CONTAINER=1 bun run test:e2e dashboards attachments \
  --project=chromium --project=chromium-serial --workers=1
```

The browser uses its own network namespace. The test runner, application servers,
and fixtures still run on the host. Playwright forwards only loopback destinations
through the host runner, preserving localhost origins and authentication settings.
No host networking, privileged container, Docker socket, or writable repository
mount is needed. The browser endpoint binds only to a Docker-assigned port on
`127.0.0.1`; anyone with access to it can control test browsers, so do not expose
it beyond the local host.

The pinned browser image version must match both the installed `playwright-core`
package and `bun.lock`; the runner checks this before starting services. Update the
image version and digest in `docker-compose.yml` when upgrading Playwright. The
container mounts only `node_modules/playwright-core` read-only and installs no
packages at startup. This mode requires a local Docker daemon with access to the
checkout's files. The runner removes the browser with the rest of its validated
stack.

An independently managed server can instead use Playwright's
`PW_TEST_CONNECT_WS_ENDPOINT` and `PW_TEST_CONNECT_EXPOSE_NETWORK` environment
variables. Do not combine an external endpoint with `E2E_BROWSER_CONTAINER=1`.
Use download streams or `download.saveAs()` in tests: `download.path()` cannot
return a host path when browsers run remotely.

Isolation addresses host interface notifications; application failures and actual
network outages still fail the suite. The option does not add retries or suppress
request failures. See the official [remote browser container guidance](https://playwright.dev/docs/docker#remote-connection)
and [network forwarding API](https://playwright.dev/docs/api/class-browsertype#browser-type-connect).
