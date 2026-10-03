import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const fixture = new URL("../tui/api-pty.ts", import.meta.url).pathname;
if (!process.env.DATABASE_URL && !process.env.TUI_TEST_ENV_FILE)
	throw new Error("A designated fixture database is required");

test.each([
	"create",
	"retry",
	"uncertain",
	"revoked",
	"read",
	"arabic",
	"notty",
])("real terminal/API journey: %s", async (mode) => {
	const privateSubprocessEnv = {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		NODE_ENV: "test",
		...(process.env.DATABASE_URL
			? { DATABASE_URL: process.env.DATABASE_URL }
			: {}),
		...(process.env.TUI_TEST_ENV_FILE
			? { TUI_TEST_ENV_FILE: process.env.TUI_TEST_ENV_FILE }
			: {}),
	};
	const { stdout } = await execute("bun", [fixture, mode], {
		env: privateSubprocessEnv,
		timeout: 15000,
		maxBuffer: 1024 * 1024,
	});
	expect(JSON.parse(stdout)).toMatchObject({ mode, passed: true });
}, 15000);
