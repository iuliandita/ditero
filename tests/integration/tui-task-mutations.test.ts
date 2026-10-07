import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const fixture = new URL("../tui/task-mutations-pty.ts", import.meta.url)
	.pathname;
if (!process.env.DATABASE_URL && !process.env.TUI_MUTATIONS_ENV_FILE)
	throw new Error("A designated fixture database is required");
test.each([
	"startup-delay",
	"update",
	"update-retry",
	"update-uncertain",
	"delete-cascade",
	"delete-retry",
	"conflict",
	"revoked",
	"read",
	"arabic",
])("actual TUI task mutation: %s", async (mode) => {
	const { stdout } = await execute("bun", [fixture, mode], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			NODE_ENV: "test",
			...(process.env.DATABASE_URL
				? { DATABASE_URL: process.env.DATABASE_URL }
				: {}),
			...(process.env.TUI_MUTATIONS_ENV_FILE
				? { TUI_MUTATIONS_ENV_FILE: process.env.TUI_MUTATIONS_ENV_FILE }
				: {}),
		},
		timeout: 15000,
		maxBuffer: 1024 * 1024,
	});
	expect(JSON.parse(stdout)).toMatchObject({
		mode,
		passed: true,
		cleanup: true,
		directLogin: true,
	});
}, 15000);
