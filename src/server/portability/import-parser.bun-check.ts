import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { CSV_HEADER } from "../../domain/portability/providers/csv.ts";
import { CSV_V1_EXCLUSIONS } from "../../domain/portability/providers/input.ts";
import { parseImportInWorker } from "./import-parser.ts";

const namespace = "fcb28f31-12ae-4c9d-82f2-1289d9fcb411";
const rows = Array.from({ length: 49_000 }, (_, index) =>
	[
		"1",
		"plain",
		namespace,
		"list",
		"Tasks",
		`task-${index}`,
		"",
		"Task",
		"a".repeat(200),
		"false",
		"",
		"",
		"false",
		"0",
		String(index),
	].join(","),
);
const csv = `${CSV_HEADER.join(",")}\n${rows.join("\n")}\n`;
const input = {
	kind: "provider",
	version: 1,
	adapter: "ditero-csv",
	adapterVersion: 1,
	sourceNamespace: namespace,
	identityMode: "stable-ids",
	exclusions: [...CSV_V1_EXCLUSIONS],
	originalCsvBase64: Buffer.from(csv).toString("base64"),
};
let ticks = 0;
let previous = performance.now();
let maxGap = 0;
const timer = setInterval(() => {
	const now = performance.now();
	ticks++;
	maxGap = Math.max(maxGap, now - previous);
	previous = now;
}, 1);
let parsedRows = 0;
let timedOut = false;
const startedAt = performance.now();
try {
	try {
		const parsed = await parseImportInWorker({
			kind: "provider",
			value: input,
			exportedAt: "2026-01-15T12:00:00.000Z",
		});
		parsedRows = parsed.conversion.document.data.tasks.length;
		assert.equal(parsedRows, 49_000);
	} catch (error) {
		assert.ok(
			error instanceof Error && "code" in error && error.code === "timeout",
		);
		assert.ok(performance.now() - startedAt >= 14_500);
		timedOut = true;
	}
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.ok(ticks > 10, `heartbeat ticks: ${ticks}`);
	assert.ok(maxGap < 500, `heartbeat gap: ${maxGap}`);
	console.log(
		JSON.stringify({
			csvBytes: Buffer.byteLength(csv),
			parsedRows,
			timedOut,
			ticks,
			maxGap,
		}),
	);
} finally {
	clearInterval(timer);
}
await assert.rejects(
	parseImportInWorker(
		{ kind: "provider", value: input, exportedAt: "2026-01-15T12:00:00.000Z" },
		{ deadline: performance.now() + 1 },
	),
	{ code: "timeout", status: 503 },
);
const controller = new AbortController();
const cancelled = parseImportInWorker(
	{ kind: "provider", value: input, exportedAt: "2026-01-15T12:00:00.000Z" },
	{ signal: controller.signal },
);
controller.abort();
await assert.rejects(cancelled, { code: "cancelled", status: 408 });
await assert.rejects(
	parseImportInWorker({ kind: "document", text: '{"schemaVersion":1}' }),
	{ code: "invalid-export", status: 400 },
);
console.log("parser checks passed");
