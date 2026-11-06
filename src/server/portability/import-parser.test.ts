import { expect, test, vi } from "vitest";
import { parseImportInWorker } from "./import-parser.ts";

test("parses small requests under the Node test runtime and preserves typed errors", async () => {
	expect(
		await parseImportInWorker({ kind: "envelope", text: '{"ok":true}' }),
	).toEqual({ ok: true });
	await expect(
		parseImportInWorker({ kind: "document", text: '{"schemaVersion":1}' }),
	).rejects.toMatchObject({ code: "invalid-export", status: 400 });
	const controller = new AbortController();
	controller.abort();
	await expect(
		parseImportInWorker(
			{ kind: "envelope", text: "{}" },
			{ signal: controller.signal },
		),
	).rejects.toMatchObject({ code: "cancelled", status: 408 });
});

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
