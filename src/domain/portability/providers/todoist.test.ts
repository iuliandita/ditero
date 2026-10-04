import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	PROVIDER_MAX_BYTES,
	PROVIDER_MAX_FIELD_BYTES,
	PROVIDER_MAX_ROWS,
	ProviderImportError,
	snapshotNamespace,
	validateProviderConversion,
} from "./common.ts";
import {
	parseProviderBinding,
	prepareProviderImportRequest,
	TODOIST_V1_EXCLUSIONS,
} from "./input.ts";
import { parseTodoistProjectCsv, TODOIST_HEADER } from "./todoist.ts";

const options = {
	exportedAt: "2026-01-15T12:00:00.000Z",
	projectFolderName: "My project",
	unsectionedListName: "Unsectioned",
};
const encoder = new TextEncoder();
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
function row(
	values: Partial<Record<(typeof TODOIST_HEADER)[number], string>> = {},
) {
	return TODOIST_HEADER.map(
		(key) =>
			({
				TYPE: "task",
				CONTENT: "Literal task",
				PRIORITY: "4",
				INDENT: "1",
				...values,
			})[key] ?? "",
	);
}
function csv(
	rows: string[][] = [row()],
	header: readonly string[] = TODOIST_HEADER,
) {
	return encoder.encode(
		`${[
			header.join(","),
			...rows.map((fields) => fields.map(quote).join(",")),
		].join("\r\n")}\r\n`,
	);
}
async function input(bytes = csv()) {
	const result = await parseTodoistProjectCsv(bytes, options);
	return {
		kind: "provider" as const,
		version: 1 as const,
		adapter: result.adapter,
		adapterVersion: 1 as const,
		sourceNamespace: result.sourceNamespace,
		identityMode: result.identityMode,
		snapshotSha256: result.snapshotSha256,
		projectFolderName: result.projectFolderName,
		unsectionedListName: result.unsectionedListName,
		exclusions: [...TODOIST_V1_EXCLUSIONS],
		originalCsvBase64: Buffer.from(bytes).toString("base64"),
	};
}
afterEach(() => vi.restoreAllMocks());
describe("Todoist project snapshot", () => {
	test("imports the synthetic documented format with literal sections, open tasks and one-level children", async () => {
		const result = await parseTodoistProjectCsv(
			readFileSync(
				new URL(
					"../../../../tests/fixtures/portability/providers/todoist-project-v1.csv",
					import.meta.url,
				),
			),
			options,
		);
		expect(result.document.data.folders.map((folder) => folder.name)).toEqual([
			"My project",
		]);
		expect(result.document.data.lists.map((list) => list.title)).toEqual([
			"Unsectioned",
			"Same section",
			"Same section",
			"Empty section",
		]);
		expect(
			result.document.data.tasks.map((task) => [
				task.title,
				task.notes,
				task.priority,
			]),
		).toEqual([
			["=literal @label", 'Description, with quotes "and" Unicode العربية', 3],
			["Child", null, 2],
			["Another task", null, 0],
		]);
		expect(result.document.data.tasks[1]?.parentId).toBe(
			result.document.data.tasks[0]?.id,
		);
		expect(
			result.document.data.tasks.every(
				(task) =>
					!task.done &&
					task.completedAt === null &&
					task.dueAt === null &&
					task.rrule === null,
			),
		).toBe(true);
		expect(result.document.data.comments).toEqual([]);
		expect(result.document.data.assignments).toEqual([]);
		expect(result.document.data.principals).toEqual([
			{ id: result.document.sourceUserId, name: "Untrusted migration owner" },
		]);
		expect(validateProviderConversion(result)).toEqual(result);
	});
	test("binds exact original bytes including excluded fields, BOM, newlines and record order", async () => {
		const original = csv([row(), row({ CONTENT: "Second" })]);
		const first = await input(original);
		expect(await input(original)).toEqual(first);
		const bom = new Uint8Array(original.length + 3);
		bom.set([239, 187, 191]);
		bom.set(original, 3);
		for (const bytes of [
			bom,
			encoder.encode(
				new TextDecoder().decode(original).replaceAll("\r\n", "\n"),
			),
			csv([row({ DATE: "every day" }), row({ CONTENT: "Second" })]),
			csv([row({ CONTENT: "Second" }), row()]),
			csv([row(), row({ CONTENT: "Second" }), row({ CONTENT: "New" })]),
		]) {
			const next = await input(bytes);
			expect(next.snapshotSha256).not.toBe(first.snapshotSha256);
			expect(next.sourceNamespace).not.toBe(first.sourceNamespace);
		}
	});
	test("reconstructs content from bytes and rejects forged digest, namespace, policy and mapping", async () => {
		const original = await input();
		const prepared = await prepareProviderImportRequest(original, options);
		expect(prepared.binding.adapter).toBe("todoist-project-csv");
		const forgedDigest = "0".repeat(64);
		await expect(
			prepareProviderImportRequest(
				{
					...original,
					snapshotSha256: forgedDigest,
					sourceNamespace: snapshotNamespace(forgedDigest),
				},
				options,
			),
		).rejects.toMatchObject({ code: "metadata-mismatch" });
		for (const modified of [
			{ ...original, sourceNamespace: "fcb28f31-12ae-4c9d-82f2-1289d9fcb411" },
			{ ...original, projectFolderName: "" },
			{ ...original, exclusions: [...TODOIST_V1_EXCLUSIONS].reverse() },
			{ ...original, unknown: "private" },
		])
			await expect(
				prepareProviderImportRequest(modified, options),
			).rejects.toMatchObject({ code: "invalid-input" });
		const { originalCsvBase64: _bytes, ...binding } = original;
		expect(parseProviderBinding(binding)).toEqual(binding);
		expect(() =>
			parseProviderBinding({
				...binding,
				originalCsvBase64: original.originalCsvBase64,
			}),
		).toThrow();
	});
	test.each([3, 4])("rejects depth %i", async (depth) => {
		await expect(
			parseTodoistProjectCsv(
				csv([row(), row({ INDENT: String(depth) })]),
				options,
			),
		).rejects.toMatchObject({ code: "invalid-graph" });
	});
	test("requires root before child and resets linkage at each section", async () => {
		for (const rows of [
			[row({ INDENT: "2" })],
			[row(), row({ TYPE: "section", CONTENT: "Next" }), row({ INDENT: "2" })],
		])
			await expect(
				parseTodoistProjectCsv(csv(rows), options),
			).rejects.toMatchObject({ code: "invalid-graph" });
	});
	test("rejects unknown headers/types and blank section names rather than guessing", async () => {
		for (const bytes of [
			csv([row()], [...TODOIST_HEADER, "unknown"]),
			csv([row({ TYPE: "completed" })]),
			csv([row({ TYPE: "section", CONTENT: " " })]),
			csv([row({ TYPE: "meta", CONTENT: "unknown=1" })]),
		])
			await expect(
				parseTodoistProjectCsv(bytes, options),
			).rejects.toBeInstanceOf(ProviderImportError);
	});
	test("excludes all dates, comments and authors without parsing literal title syntax", async () => {
		const result = await parseTodoistProjectCsv(
			csv([
				row({
					CONTENT: "@label **bold**",
					DATE: "2026-01-20",
					DEADLINE: "tomorrow",
					DURATION: "30",
					AUTHOR: "External person",
					RESPONSIBLE: "Another person",
				}),
				row({ TYPE: "note", CONTENT: "Comment" }),
			]),
			options,
		);
		expect(result.document.data.tasks).toHaveLength(1);
		expect(result.document.data.tasks[0]).toMatchObject({
			title: "@label **bold**",
			dueAt: null,
			dueAllDay: false,
			completedAt: null,
			done: false,
		});
		expect(result.document.data.comments).toHaveLength(0);
	});
	test.each([
		["", 3],
		["1", 3],
		["2", 2],
		["3", 1],
		["4", 0],
	])("maps priority %s to %i", async (priority, expected) => {
		expect(
			(
				await parseTodoistProjectCsv(
					csv([row({ PRIORITY: priority })]),
					options,
				)
			).document.data.tasks[0]?.priority,
		).toBe(expected);
	});
	test("does not execute option or conversion getters and rejects hidden/symbol/prototype values", async () => {
		let accessed = false;
		const getter = { ...options };
		Object.defineProperty(getter, "projectFolderName", {
			enumerable: true,
			get() {
				accessed = true;
				return "private";
			},
		});
		await expect(parseTodoistProjectCsv(csv(), getter)).rejects.toMatchObject({
			code: "invalid-metadata",
		});
		expect(accessed).toBe(false);
		const result = await parseTodoistProjectCsv(csv(), options);
		const hostile = { ...result };
		Object.defineProperty(hostile, "snapshotSha256", {
			enumerable: true,
			get() {
				accessed = true;
				return result.snapshotSha256;
			},
		});
		expect(() => validateProviderConversion(hostile)).toThrow();
		expect(accessed).toBe(false);
		for (const key of ["__proto__", "constructor", "prototype"]) {
			const changed = structuredClone(result);
			Object.defineProperty(changed.document.data.tasks[0], key, {
				enumerable: true,
				value: "private",
			});
			expect(() => validateProviderConversion(changed)).toThrow();
		}
		const hidden = { ...result };
		Object.defineProperty(hidden, "secret", { value: "private" });
		expect(() => validateProviderConversion(hidden)).toThrow();
		const symbol = { ...result, [Symbol("secret")]: "private" };
		expect(() => validateProviderConversion(symbol)).toThrow();
	});
	test("honors cancellation and a single deadline around asynchronous hashing", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			parseTodoistProjectCsv(csv(), { ...options, signal: controller.signal }),
		).rejects.toMatchObject({ code: "cancelled" });
		await expect(
			parseTodoistProjectCsv(csv(), {
				...options,
				deadline: performance.now() - 1,
			}),
		).rejects.toMatchObject({ code: "timeout" });
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		const fresh = new AbortController();
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
			const result = await digest(...args);
			fresh.abort();
			return result;
		});
		await expect(
			parseTodoistProjectCsv(csv(), { ...options, signal: fresh.signal }),
		).rejects.toMatchObject({ code: "cancelled" });
	});
	test("fails clearly when browser WebCrypto is unavailable", async () => {
		vi.stubGlobal("crypto", undefined);
		try {
			await expect(
				parseTodoistProjectCsv(csv(), options),
			).rejects.toMatchObject({ code: "secure-context-required" });
		} finally {
			vi.unstubAllGlobals();
		}
	});
	test("enforces input, field and row bounds before producing a partial conversion", async () => {
		await expect(
			parseTodoistProjectCsv(new Uint8Array(PROVIDER_MAX_BYTES + 1), options),
		).rejects.toMatchObject({ code: "byte-limit" });
		await expect(
			parseTodoistProjectCsv(
				csv([row({ DESCRIPTION: "x".repeat(PROVIDER_MAX_FIELD_BYTES) })]),
				options,
			),
		).rejects.toMatchObject({ code: "field-limit" });
		await expect(
			parseTodoistProjectCsv(
				encoder.encode(
					TODOIST_HEADER.join(",") + "\n".repeat(PROVIDER_MAX_ROWS + 3),
				),
				options,
			),
		).rejects.toMatchObject({ code: "row-limit" });
		await expect(
			parseTodoistProjectCsv(csv([row({ CONTENT: "ع".repeat(251) })]), options),
		).rejects.toMatchObject({ code: "field-limit" });
	});
	test("a deadline expiring during hashing refuses the entire conversion", async () => {
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		const now = performance.now();
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
			const value = await digest(...args);
			vi.spyOn(performance, "now").mockReturnValue(now + 20_000);
			return value;
		});
		await expect(
			parseTodoistProjectCsv(csv(), { ...options, deadline: now + 1_000 }),
		).rejects.toMatchObject({ code: "timeout" });
	});
	test("refuses forged completed/due state, cross-section child and foreign owner", async () => {
		const result = await parseTodoistProjectCsv(
			csv([
				row(),
				row({ INDENT: "2" }),
				row({ TYPE: "section", CONTENT: "Next" }),
				row({ CONTENT: "Other" }),
			]),
			options,
		);
		for (const patch of [
			{ done: true },
			{ dueAt: "2026-01-20T00:00:00.000Z" },
			{ parentId: result.document.data.tasks[2]?.id },
		]) {
			const changed = structuredClone(result);
			Object.assign(changed.document.data.tasks[1] ?? {}, patch);
			expect(() => validateProviderConversion(changed)).toThrow();
		}
		const foreign = structuredClone(result);
		Object.assign(foreign.document.data.lists[0] ?? {}, {
			ownerId: "external",
		});
		expect(() => validateProviderConversion(foreign)).toThrow();
	});
});
