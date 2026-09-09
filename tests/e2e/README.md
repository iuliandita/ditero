# Browser tests

Run the suite with `bun run test:e2e`. Filters and Playwright flags are forwarded:

```sh
bun run test:e2e dashboards --project=chromium
```

For hosts where Docker interface changes interrupt Chromium requests with
`net::ERR_NETWORK_CHANGED`, isolate the browsers in a container:

```sh
E2E_BROWSER_CONTAINER=1 bun run test:e2e dashboards attachments --project=chromium
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
