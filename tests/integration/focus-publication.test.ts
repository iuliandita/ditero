import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

test("actual Zero default and explicit publications exclude private focus clocks", () => {
	const probe = spawnSync(
		process.execPath,
		["tests/support/focus-publication.mjs"],
		{
			encoding: "utf8",
		},
	);
	expect(probe.status, probe.stderr).toBe(0);
	expect(probe.stdout).toContain("exclude private clocks and their columns");
}, 30_000);
