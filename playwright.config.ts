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
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
	webServer: [
		{
			command: "bun run dev:server",
			port: 3000,
			reuseExistingServer: false,
			timeout: 60_000,
			env: {
				DATABASE_URL: databaseURL,
				NODE_ENV: "test",
				DITERO_E2E: "1",
				BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-32-bytes",
				BETTER_AUTH_URL: "http://localhost:3000",
				DITERO_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
				DITERO_PASSKEY_ORIGIN: "http://localhost:5173",
				DITERO_REGISTRATION_MODE: "open",
				// Allows exactly the one private address the ntfy stub binds. The
				// stub cannot be on loopback: safe-http refuses 127.0.0.0/8
				// unconditionally and no allowlist may re-enable it.
				DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS: `${NTFY_HOST}/32`,
				// A 30s scan tick would put the reminder e2e past its timeout; the
				// late threshold must stay at >= 2 ticks (config/scheduler.ts).
				DITERO_SCHEDULER_TICK_MS: "2000",
				DITERO_SCHEDULER_LATE_THRESHOLD_MS: "5000",
			},
		},
		{
			command: "bun run tests/e2e/ntfy-stub.ts",
			url: `http://${NTFY_HOST}:4599/health`,
			reuseExistingServer: false,
			timeout: 30_000,
		},
		{
			command: "bun run dev:web",
			port: 5173,
			reuseExistingServer: false,
			timeout: 60_000,
			env: { VITE_ZERO_URL: "http://localhost:4849" },
		},
	],
});
