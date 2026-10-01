# Browser tests

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
a fresh test stack. Do not run phases, shards, or integration tests concurrently
on the same host: the Compose project and published ports are fixed. CI shards
run on separate hosted runners. The separate output directories and JSON reports
preserve evidence from both phases; CI uploads `test-results/` for each shard with
a seven-day retention period.

Routine authenticated fixtures use context-bound API signup with UUID addresses
under the reserved `example.test` domain, then wait for the real workspace to sync.
They do not depend on signup-form interaction. Dedicated registration, refusal,
and locale tests still exercise the real form. Use the shared fixture helpers
rather than timestamp addresses or another signup wrapper.

For the CI optimization, the baseline is exactly 230 browser cases: 216 Chromium,
7 Firefox, and 7 WebKit. The candidate preserves those cases and adds two public
Zero shutdown regressions: 232 total, with 139 isolated and 79 serial Chromium
cases. Before timing runs, compare the six phase/shard discoveries with both the
original baseline and reviewed candidate, using browser, file, and title as the
identity (normalize `chromium-serial` to `chromium`). Their union must contain every
original case and exactly the two added regressions, with no duplicates. The
shutdown tests control browser idle scheduling and IndexedDB completion to verify
accepted edits, persistence failure, explicit retry, and offline cache recovery.

Repeat the complete CI workflow three times at the same candidate commit. For
each run, inspect all six JSON reports and require all 232 candidate cases to execute and
pass without skips or retry-only passes. Also require checks, integration, all
three container smokes, and the aggregate `verify` job to pass. Measure whole
workflow wall time from its start through `verify`, including runner setup and
both browser phases; each run must finish within 18 minutes 20 seconds, leaving
margin under 20 minutes. Record run URLs,
revision, case totals, results, and elapsed time for all three runs. A green label
check or discovery-only run is not execution or timing proof.

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
mount is needed. The browser endpoint binds only to `127.0.0.1:53000`; anyone with
access to it can control test browsers, so do not expose it beyond the local host.

The pinned browser image version must match both the installed `playwright-core`
package and `bun.lock`; the runner checks this before starting services. Update the
image version and digest in `docker-compose.yml` when upgrading Playwright. The
container mounts only `node_modules/playwright-core` read-only and installs no
packages at startup. This mode requires a local Docker daemon with access to the
checkout's files. Compose removes the browser with the rest of the test stack.

An independently managed server can instead use Playwright's
`PW_TEST_CONNECT_WS_ENDPOINT` and `PW_TEST_CONNECT_EXPOSE_NETWORK` environment
variables. Do not combine an external endpoint with `E2E_BROWSER_CONTAINER=1`.
Use download streams or `download.saveAs()` in tests: `download.path()` cannot
return a host path when browsers run remotely.

Isolation addresses host interface notifications; application failures and actual
network outages still fail the suite. The option does not add retries or suppress
request failures. See the official [remote browser container guidance](https://playwright.dev/docs/docker#remote-connection)
and [network forwarding API](https://playwright.dev/docs/api/class-browsertype#browser-type-connect).
