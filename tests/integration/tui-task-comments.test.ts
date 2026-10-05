import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vitest";

// budget:begin
// Names match the driver's constants (the offline control asserts parity).
// Driver worst case: process startup, body + one in-flight body query (every
// body query is checkpointed and capped by query_timeout), then cleanup + one
// independent in-flight cleanup DML statement, then the failure record and
// exit. The parent must outlast all of it, and Vitest must outlast the parent.
const BODY_MS = 13000;
const CLEANUP_MS = 8000;
const STATEMENT_MS = 5000;
const CONNECT_MS = 1000;
const RECORD_MS = 2000;
const STARTUP_MS = 2000;
const IN_FLIGHT_MS = STATEMENT_MS + CONNECT_MS;
const PARENT_MS =
	STARTUP_MS + BODY_MS + IN_FLIGHT_MS + CLEANUP_MS + IN_FLIGHT_MS + RECORD_MS;
const VITEST_MS = PARENT_MS + 6000;
// budget:end
const execute = promisify(execFile);
const fixture = new URL("../tui/task-comments-pty.ts", import.meta.url)
	.pathname;
if (!process.env.DATABASE_URL && !process.env.TUI_COMMENTS_ENV_FILE)
	throw new Error("A designated fixture database is required");
test.each(["paged", "narrow", "no-color", "arabic", "revoked", "membership"])(
	"actual TUI task comments: %s",
	async (mode) => {
		const { stdout } = await execute("bun", [fixture, mode], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: process.env.HOME ?? "",
				NODE_ENV: "test",
				...(process.env.DATABASE_URL
					? { DATABASE_URL: process.env.DATABASE_URL }
					: {}),
				...(process.env.TUI_COMMENTS_ENV_FILE
					? { TUI_COMMENTS_ENV_FILE: process.env.TUI_COMMENTS_ENV_FILE }
					: {}),
				...(process.env.TUI_COMMENTS_EXPECTED_DATABASE
					? {
							TUI_COMMENTS_EXPECTED_DATABASE:
								process.env.TUI_COMMENTS_EXPECTED_DATABASE,
						}
					: {}),
				...(process.env.TUI_COMMENTS_CAPTURE_DIR
					? { TUI_COMMENTS_CAPTURE_DIR: process.env.TUI_COMMENTS_CAPTURE_DIR }
					: {}),
			},
			timeout: PARENT_MS,
			maxBuffer: 1024 * 1024,
		});
		expect(JSON.parse(stdout)).toEqual({
			mode,
			passed: true,
			requests: expect.any(Number),
			writes: 0,
			cleanup: true,
			directLogin: true,
		});
	},
	VITEST_MS,
);
