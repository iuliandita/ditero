import { defineConfig, devices } from "@playwright/test";
import { privateHost } from "./tests/support/private-host.ts";

// The ntfy stub cannot live on loopback: safe-http refuses 127.0.0.0/8
// unconditionally and no allowlist may re-enable it (that is the point of the
// SSRF boundary). Bind the stub to a real private interface instead -- the
// docker bridge, which any machine running this suite has -- and allowlist that
// one address for the API process only.
const NTFY_HOST = privateHost();
// Read by tests/e2e/notifications.spec.ts (workers inherit this process env).
process.env.E2E_NTFY_URL = `http://${NTFY_HOST}:4599`;

const databaseURL =
	process.env.E2E_DATABASE_URL ??
	"postgres://postgres:pass@localhost:55432/ditero_e2e";

// The mail-path e2e needs an SMTP-configured deployment, and the email-absent UI
// states (email row unavailable, a stored email row surviving SMTP going away)
// need one WITHOUT SMTP -- mutually exclusive in one process env. So the default
// app server (3000/5173) runs SMTP-less and a second, API-only server (3001)
// runs with SMTP pointed at the loopback sink. Both share the one Postgres, so
// an email row saved through the SMTP server renders (masked, unavailable, still
// removable) on the SMTP-less one -- exactly the "SMTP later disappeared" case.
const SMTP_PORT = 4600;
const SMTP_HTTP_PORT = 4601;
process.env.E2E_SMTP_HTTP_URL = `http://127.0.0.1:${SMTP_HTTP_PORT}`;
process.env.E2E_MAIL_API_URL = "http://localhost:3001";

// Env shared by both app servers; each overrides API_PORT + BETTER_AUTH_URL and
// the SMTP server adds DITERO_SMTP_*.
const appEnv = {
	DATABASE_URL: databaseURL,
	NODE_ENV: "test",
	DITERO_E2E: "1",
	BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-32-bytes",
	DITERO_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
	DITERO_PASSKEY_ORIGIN: "http://localhost:5173",
	DITERO_REGISTRATION_MODE: "open",
	// Served to the web client from /api/config. tests/e2e/docker-compose.yml
	// publishes zero-cache on 4849, not the 4848 default, and the browser reaches
	// this through vite's /api proxy -- so it belongs on the API server, not the
	// web one.
	PUBLIC_ZERO_URL: "http://localhost:4849",
	// Allows exactly the one private address the ntfy stub binds. Both servers
	// drain the shared outbox under SKIP LOCKED, so the SMTP server must carry the
	// same allowlist or it would fail an ntfy delivery it happens to claim.
	DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS: `${NTFY_HOST}/32`,
	// A 30s scan tick would put the reminder e2e past its timeout; the late
	// threshold must stay at >= 2 ticks (config/scheduler.ts).
	DITERO_SCHEDULER_TICK_MS: "2000",
	DITERO_SCHEDULER_LATE_THRESHOLD_MS: "5000",
};

export default defineConfig({
	testDir: "tests/e2e",
	globalSetup: "./tests/e2e/global-setup.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	timeout: 45_000,
	expect: { timeout: 7_000 },
	reporter: [["list"]],
	use: {
		baseURL: "http://localhost:5173",
		trace: "on-first-retry",
		// Negative-offset on purpose: CI runners are UTC, where a date rendered in
		// the wrong zone looks correct. Keeps the weekday assertions load-bearing.
		timezoneId: "America/New_York",
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			// Not `dev:server`: `--hot` orphans child processes, which then squat
			// these ports on the next run. (It also used to die on vite's paraglide
			// tree rewrite; that cause is gone since the output structure is pinned
			// in paraglide.options.ts, but the orphaning stands on its own.)
			command: "bun run src/server/index.ts",
			port: 3000,
			reuseExistingServer: false,
			timeout: 60_000,
			env: {
				...appEnv,
				API_PORT: "3000",
				BETTER_AUTH_URL: "http://localhost:3000",
			},
		},
		{
			// API-only SMTP deployment for the mail-path spec. No web app: the mail
			// test drives it through an APIRequestContext and reads the wire off the
			// sink, and the SMTP-less UI states render on the default web app against
			// the shared DB.
			command: "bun run src/server/index.ts",
			port: 3001,
			reuseExistingServer: false,
			timeout: 60_000,
			env: {
				...appEnv,
				API_PORT: "3001",
				BETTER_AUTH_URL: "http://localhost:3001",
				DITERO_SMTP_HOST: "127.0.0.1",
				DITERO_SMTP_PORT: String(SMTP_PORT),
				DITERO_SMTP_FROM: "Ditero <ditero@t.dev>",
				// The sink speaks cleartext SMTP; opt out of the TLS-required default.
				DITERO_SMTP_ALLOW_INSECURE: "true",
				// Passive API replica: no scan/drain/poll, so it shares the DB with
				// the default server without ever claiming its outbox rows -- the
				// reminder/ack pipeline stays single-server for ack-live.spec.
				DITERO_BACKGROUND_JOBS: "0",
			},
		},
		{
			command: "bun run tests/e2e/ntfy-stub.ts",
			url: `http://${NTFY_HOST}:4599/health`,
			reuseExistingServer: false,
			timeout: 30_000,
		},
		{
			command: "bun run tests/e2e/smtp-sink-server.ts",
			url: `http://127.0.0.1:${SMTP_HTTP_PORT}/health`,
			reuseExistingServer: false,
			timeout: 30_000,
			env: {
				E2E_SMTP_PORT: String(SMTP_PORT),
				E2E_SMTP_HTTP_PORT: String(SMTP_HTTP_PORT),
			},
		},
		{
			command: "bun run dev:web",
			port: 5173,
			reuseExistingServer: false,
			timeout: 60_000,
		},
	],
});
