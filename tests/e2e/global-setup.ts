import { execFileSync } from "node:child_process";

// Seed a deterministic shared workspace before the suite runs. Bun executes the
// seed so it shares the app's TS/schema toolchain.
export default function globalSetup() {
	execFileSync("bun", ["run", "src/db/seed-e2e.ts"], {
		stdio: "inherit",
		env: process.env,
	});
}
