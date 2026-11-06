import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";

test("Bun parser workers keep the event loop live and terminate on timeout or cancellation", async () => {
	const result = await promisify(execFile)(
		"bun",
		["run", `${import.meta.dirname}/import-parser.bun-check.ts`],
		{ timeout: 60_000 },
	);
	console.log(result.stdout.trim());
	expect(result.stdout).toContain("parser checks passed");
}, 65_000);

test("rejects a provider envelope over its byte cap before parsing the JSON tree", async () => {
	const { performImportParse } = await import("./import-parser-work.ts");
	const text = JSON.stringify({
		pad: "x".repeat(32 * 1024 * 1024),
		"in\u0070ut": {},
	});
	const parse = vi.spyOn(JSON, "parse");
	try {
		const reply = await performImportParse({ kind: "envelope", text }, 15_000);
		expect(reply).toMatchObject({
			ok: false,
			code: "request-limit",
			status: 413,
		});
		expect(parse.mock.calls.some(([argument]) => argument === text)).toBe(
			false,
		);
	} finally {
		parse.mockRestore();
	}
});
