import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const execute = promisify(execFile);
const fixture = new URL("../tui/task-ordering-pty.ts", import.meta.url)
	.pathname;
if (!process.env.DATABASE_URL && !process.env.TUI_ORDERING_ENV_FILE)
	throw new Error("A designated fixture database is required");
const expected = [
	"move",
	"subtask",
	"cancel-help-paste",
	"stale-self",
	"sibling-race",
	"retry",
	"uncertain-exit",
	"revoked",
	"read",
	"tie",
	"malformed",
	"arabic",
];
// The fixture owns its mode list; this suite must run exactly those modes.
const declared = /const modes = \[([^\]]*)\]/.exec(
	readFileSync(fixture, "utf8"),
)?.[1];
if (!declared) throw new Error("The fixture declares no modes");
const modes = [...declared.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
if (JSON.stringify(modes) !== JSON.stringify(expected))
	throw new Error(`Fixture modes differ from the suite: ${modes.join(",")}`);

// Only the explicit more-than-100-row case needs the longer bound.
const limit = (mode: string) => (mode === "move" ? 30000 : 14000);
test.each(expected)("actual TUI task ordering: %s", async (mode) => {
	const { stdout } = await execute("bun", ["--no-env-file", fixture, mode], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			NODE_ENV: "test",
			DITERO_TUI_ORDERING_FIXTURE: "1",
			...(process.env.DATABASE_URL
				? { DATABASE_URL: process.env.DATABASE_URL }
				: {}),
			...(process.env.TUI_ORDERING_ENV_FILE
				? { TUI_ORDERING_ENV_FILE: process.env.TUI_ORDERING_ENV_FILE }
				: {}),
			...(process.env.TUI_ORDERING_FRAME_PATH
				? { TUI_ORDERING_FRAME_PATH: process.env.TUI_ORDERING_FRAME_PATH }
				: {}),
			...(process.env.TUI_ORDERING_CAPTURE_DIR
				? { TUI_ORDERING_CAPTURE_DIR: process.env.TUI_ORDERING_CAPTURE_DIR }
				: {}),
			...(process.env.TUI_ORDERING_CAPTURE_STYLE
				? { TUI_ORDERING_CAPTURE_STYLE: process.env.TUI_ORDERING_CAPTURE_STYLE }
				: {}),
		},
		timeout: limit(mode) + 2000,
		maxBuffer: 1024 * 1024,
	});
	expect(JSON.parse(stdout)).toMatchObject({
		mode,
		passed: true,
		cleanup: true,
		directLogin: true,
	});
}, 32000);
