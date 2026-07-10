import { defineConfig, devices } from "@playwright/test";

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
				BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-32-bytes",
				BETTER_AUTH_URL: "http://localhost:3000",
				DITERO_REGISTRATION_MODE: "open",
			},
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
