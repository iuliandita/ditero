import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { buildImportPlan } from "../import-plan.ts";
import { PROVIDER_MAX_BYTES, ProviderImportError } from "./common.ts";
import { CSV_HEADER, exportTaskCsv, parseTaskCsv } from "./csv.ts";

const namespace = "fcb28f31-12ae-4c9d-82f2-1289d9fcb411";
const exportedAt = "2026-01-15T12:00:00.000Z";
const encoder = new TextEncoder();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function row(overrides: Partial<Record<string, string>> = {}): string[] {
	const fields: Record<string, string | undefined> = {
		csv_version: "1",
		text_encoding: "plain",
		source_namespace: namespace,
		list_id: "list",
		list_title: "Shopping",
		task_id: "task",
		parent_task_id: "",
		title: "Buy apples",
		notes: "",
		done: "false",
		completed_at: "",
		due_at: "",
		due_all_day: "false",
		priority: "0",
		sort_index: "0",
		...overrides,
	};
	return CSV_HEADER.map((name) => fields[name] ?? "");
}
function csv(
	rows: string[][] = [row()],
	header: readonly string[] = CSV_HEADER,
): Uint8Array {
	return encoder.encode(
		`${[header.join(","), ...rows.map((fields) => fields.map(quote).join(","))].join("\r\n")}\r\n`,
	);
}
function parse(input = csv()) {
	return parseTaskCsv(input, { exportedAt });
}
function refusal(input: Uint8Array, code: string) {
	let failure: unknown;
	try {
		parse(input);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(ProviderImportError);
	expect(failure).toMatchObject({ code });
}
afterEach(() => vi.restoreAllMocks());

describe("versioned task CSV", () => {
	test("normalizes the checked-in fixture without introducing authority or history", () => {
		const result = parse(
			readFileSync(
				new URL(
					"../../../../tests/fixtures/portability/providers/csv-v1.csv",
					import.meta.url,
				),
			),
		);
		expect(result.adapter).toBe("ditero-csv");
		expect(result.identityMode).toBe("stable-ids");
		expect(result.findings).toEqual([
			{ code: "untrusted-migration-owner", path: "sourceUserId" },
		]);
		expect(result.document.sourceUserId).toBe(
			`migration:ditero-csv:1:${namespace}:owner`,
		);
		expect(
			result.document.data.tasks.map((task) => [
				task.title,
				task.parentId,
				task.dueAt,
			]),
		).toEqual([
			["Prepare groceries", null, "2026-01-16T08:30:00.000Z"],
			["Buy apples", `csv:1:${namespace}:task:parent`, null],
		]);
		expect(result.document.data.assignments).toEqual([]);
		expect(result.document.data.comments).toEqual([]);
		expect(result.document.data.attachments).toEqual([]);
		expect(
			result.document.data.tasks.every(
				(task) => task.rrule === null && task.reminderTime === null,
			),
		).toBe(true);
	});

	test("accepts one UTF-8 BOM and canonicalizes namespace case", () => {
		const body = csv([row({ source_namespace: namespace.toUpperCase() })]);
		const bom = new Uint8Array(body.length + 3);
		bom.set([0xef, 0xbb, 0xbf]);
		bom.set(body, 3);
		expect(parse(bom).sourceNamespace).toBe(namespace);
	});

	test("preserves Unicode, quotes, commas and embedded line endings", () => {
		const title = 'Café, "bread" العربية';
		const notes = "Line one\r\nLine two\n=literal formula";
		const result = parse(csv([row({ title, notes })]));
		expect(result.document.data.tasks[0]?.title).toBe(title);
		expect(result.document.data.tasks[0]?.notes).toBe(notes);
		expect(parse(exportTaskCsv(result)).document).toEqual(result.document);
	});

	test("preserves plain apostrophes without guessing spreadsheet escapes", () => {
		expect(
			parse(csv([row({ title: "'=SUM(A1:A2)", notes: "'original" })])).document
				.data.tasks[0],
		).toMatchObject({ title: "'=SUM(A1:A2)", notes: "'original" });
	});

	test.each([
		'=HYPERLINK("https://example.com")',
		"+1+1",
		"-1+1",
		"@SUM(A1)",
		"\t=1",
		"\r\n=1",
		"  =1",
		"'=1",
		'quote, "cell"',
	])("neutralizes every free-text and opaque-ID cell and exactly restores %j", (value) => {
		const result = parse(
			csv([
				row({
					list_id: "=list",
					task_id: "@task",
					list_title: value,
					title: value,
					notes: value,
				}),
			]),
		);
		const text = new TextDecoder().decode(exportTaskCsv(result));
		expect(text).toContain('"\'=list"');
		expect(text).toContain('"\'@task"');
		expect(text).toContain('"apostrophe-v1"');
		expect(text).toContain(quote(`'${value}`));
		const again = parse(encoder.encode(text));
		expect(again.document).toEqual(result.document);
		expect(parse(exportTaskCsv(again)).document).toEqual(result.document);
	});

	test("requires the declared prefix without accepting a bare escape as data", () => {
		const encoded = row({
			text_encoding: "apostrophe-v1",
			list_id: "'list",
			task_id: "'task",
			list_title: "'Shopping",
			title: "'=1",
			notes: "'",
		});
		refusal(csv([encoded]), "invalid-row");
	});

	test("row reorder and export time do not change document or ledger identities", async () => {
		const first = row({ task_id: "b", sort_index: "7" });
		const second = row({ task_id: "a", sort_index: "2" });
		const a = parse(csv([first, second]));
		const b = parseTaskCsv(csv([second, first]), {
			exportedAt: "2026-02-01T00:00:00.000Z",
		});
		expect(b.document.data).toEqual(a.document.data);
		const context = {
			ownerUserId: "caller",
			sourceId: "chosen-source",
			mappings: {
				workspaces: {
					[a.document.data.workspaces[0]?.id ?? ""]: "destination",
				},
				principals: { [a.document.sourceUserId]: "caller" },
			},
		};
		const planA = await buildImportPlan(a.document, context);
		const planB = await buildImportPlan(b.document, context);
		expect(planB.planDigest).toBe(planA.planDigest);
		expect(planB.items.map((item) => item.sourceKey)).toEqual(
			planA.items.map((item) => item.sourceKey),
		);
	});

	test("changed content retains task IDs and changed namespace separates them", () => {
		const first = parse();
		const edited = parse(csv([row({ title: "Edited title" })]));
		const other = parse(
			csv([row({ source_namespace: "fcb28f31-12ae-4c9d-82f2-1289d9fcb412" })]),
		);
		expect(edited.document.data.tasks[0]?.id).toBe(
			first.document.data.tasks[0]?.id,
		);
		expect(other.document.data.tasks[0]?.id).not.toBe(
			first.document.data.tasks[0]?.id,
		);
	});

	test("prototype-shaped source IDs remain literal Map keys", () => {
		const result = parse(
			csv([row({ list_id: "__proto__", task_id: "constructor" })]),
		);
		expect(result.document.data.tasks[0]?.id).toBe(
			`csv:1:${namespace}:task:constructor`,
		);
		expect(parse(exportTaskCsv(result)).document).toEqual(result.document);
	});

	test.each([
		["missing header", encoder.encode("title\nprivate content\n")],
		["duplicate header", csv([row()], [...CSV_HEADER.slice(0, -1), "title"])],
		["unknown header", csv([row()], [...CSV_HEADER, "assignee"])],
		["ragged row", csv([row().slice(0, -1)])],
		["extra cell", csv([[...row(), "private"]])],
		["unclosed quote", encoder.encode(`${CSV_HEADER.join(",")}\n"private`)],
		[
			"text after quote",
			encoder.encode(`${CSV_HEADER.join(",")}\n"1"unexpected,rest`),
		],
		[
			"quote in bare field",
			encoder.encode(`${CSV_HEADER.join(",")}\n1,pla"in,rest`),
		],
		["bare carriage return", encoder.encode(`${CSV_HEADER.join(",")}\r1`)],
		["empty document", new Uint8Array()],
		["header only", encoder.encode(`${CSV_HEADER.join(",")}\n`)],
		["blank record", encoder.encode(`${new TextDecoder().decode(csv())}\r\n`)],
	])("refuses %s", (_, input) => refusal(input, "invalid-csv"));

	test.each([
		{ csv_version: "2" },
		{ text_encoding: "auto" },
		{ source_namespace: "not-a-uuid" },
	])("refuses unrecognized metadata %j", (fields) =>
		refusal(csv([row(fields)]), "invalid-metadata"));

	test("refuses namespace, encoding, and list-title disagreements", () => {
		refusal(
			csv([
				row(),
				row({
					task_id: "two",
					source_namespace: "fcb28f31-12ae-4c9d-82f2-1289d9fcb412",
				}),
			]),
			"invalid-metadata",
		);
		refusal(
			csv([row(), row({ task_id: "two", text_encoding: "apostrophe-v1" })]),
			"invalid-metadata",
		);
		refusal(
			csv([row(), row({ task_id: "two", list_title: "Different" })]),
			"invalid-metadata",
		);
	});

	test.each([
		{ task_id: "" },
		{ task_id: " spaced" },
		{ title: " " },
		{ priority: "4" },
		{ sort_index: "-1" },
		{ sort_index: "01" },
		{ done: "yes" },
		{ due_all_day: "true" },
		{ completed_at: exportedAt },
		{ notes: "private\u0000text" },
	])("refuses invalid row values %j", (fields) =>
		refusal(csv([row(fields)]), "invalid-row"));

	test("refuses duplicate task IDs even across lists", () => {
		refusal(csv([row(), row({ list_id: "another" })]), "invalid-row");
	});

	test.each([
		"2026-02-29T00:00:00Z",
		"2026-01-01",
		"tomorrow",
		"2026-01-01T12:00:00",
		"2026-01-01T24:00:00Z",
		"2026-01-01T00:00:00+25:00",
	])("refuses ambiguous or impossible date %s", (due_at) =>
		refusal(csv([row({ due_at })]), "invalid-date"));

	test("preserves completed timestamp without fabricating prior events", () => {
		const task = parse(
			csv([row({ done: "true", completed_at: "2026-01-15T13:00:00+01:00" })]),
		).document.data.tasks[0];
		expect(task).toMatchObject({ done: true, completedAt: exportedAt });
	});

	test.each([
		[row({ parent_task_id: "missing" })],
		[row({ parent_task_id: "task" })],
		[
			row(),
			row({ task_id: "child", parent_task_id: "task", list_id: "other" }),
		],
		[
			row(),
			row({ task_id: "child", parent_task_id: "task" }),
			row({ task_id: "grandchild", parent_task_id: "child" }),
		],
		[
			row({ parent_task_id: "child" }),
			row({ task_id: "child", parent_task_id: "task" }),
		],
	])("refuses invalid parent relationships", (...rows) =>
		refusal(csv(rows), "invalid-graph"));

	test("enforces UTF-8 decoding, raw-byte and multibyte field limits", () => {
		refusal(new Uint8Array([0xc3, 0x28]), "invalid-encoding");
		refusal(new Uint8Array(PROVIDER_MAX_BYTES + 1), "byte-limit");
		refusal(csv([row({ title: "é".repeat(251) })]), "field-limit");
		refusal(csv([row({ notes: "x".repeat(32 * 1024) })]), "field-limit");
		refusal(csv([row({ notes: "é".repeat(17_000) })]), "field-limit");
	});

	test("counts generated lists and descriptive authority rows in the total limit", () => {
		const rows = Array.from({ length: 49_997 }, (_, index) =>
			row({ task_id: String(index) }),
		);
		refusal(csv(rows), "row-limit");
	});

	test("cancellation and absolute deadline refuse before returning a result", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() =>
			parseTaskCsv(csv(), { exportedAt, signal: controller.signal }),
		).toThrowError(new ProviderImportError("cancelled"));
		expect(() =>
			parseTaskCsv(csv(), { exportedAt, deadline: performance.now() - 1 }),
		).toThrowError(new ProviderImportError("timeout"));
		let tick = 0;
		vi.spyOn(performance, "now").mockImplementation(() => tick++);
		expect(() =>
			parseTaskCsv(csv([row({ notes: "x".repeat(2_000) })]), {
				exportedAt,
				deadline: 5,
			}),
		).toThrowError(new ProviderImportError("timeout"));
	});

	test("error messages never echo source cells", () => {
		const privateText = "PRIVATE-CONTENT-NEVER-LOG";
		try {
			parse(csv([row({ title: privateText, due_at: privateText })]));
			throw new Error("Expected refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(ProviderImportError);
			expect(String(error)).toBe("ProviderImportError: invalid-date");
			expect(JSON.stringify(error)).not.toContain(privateText);
		}
	});
});
