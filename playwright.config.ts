import { defineConfig, devices } from "@playwright/test";

// Requires the docker dev stack up (postgres + zero-cache): `docker compose up -d`.
// Playwright boots the Elysia API and the vite web server itself; global-setup
// seeds the shared workspace. DITERO_DEFAULT_WORKSPACE_ID makes new signups
// auto-join that workspace (dev/e2e only).
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
			env: { DITERO_DEFAULT_WORKSPACE_ID: "w_shared_e2e" },
		},
		{
			command: "bun run dev:web",
			port: 5173,
			reuseExistingServer: false,
			timeout: 60_000,
		},
	],
});
