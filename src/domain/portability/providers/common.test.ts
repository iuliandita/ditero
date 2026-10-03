import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { ProviderImportError, validateProviderConversion } from "./common.ts";
import { exportTaskCsv, parseTaskCsv } from "./csv.ts";

function fixture() {
	return parseTaskCsv(
		readFileSync(
			new URL(
				"../../../../tests/fixtures/portability/providers/csv-v1.csv",
				import.meta.url,
			),
		),
		{ exportedAt: "2026-01-15T12:00:00.000Z" },
	);
}

function present<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture row");
	return value;
}

describe("provider conversion evidence", () => {
	test("requires the exact versioned contract and explicit ownership disclaimer", () => {
		const result = fixture();
		expect(validateProviderConversion(result)).toEqual(result);
		for (const modified of [
			{ ...result, adapterVersion: 2 },
			{ ...result, identityMode: "title-hash" },
			{ ...result, findings: [] },
			{ ...result, token: "private" },
			{
				...result,
				findings: [{ ...result.findings[0], displayName: "private" }],
			},
		])
			expect(() => validateProviderConversion(modified)).toThrowError(
				new ProviderImportError("invalid-result"),
			);
	});

	test("refuses external user substitution or mismatched namespace", () => {
		const result = fixture();
		result.document.sourceUserId = "signed-in-user";
		expect(() => validateProviderConversion(result)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		const another = fixture();
		another.sourceNamespace = "fcb28f31-12ae-4c9d-82f2-1289d9fcb412";
		expect(() => validateProviderConversion(another)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
	});

	test("refuses a forged authorship name and additional source principals", () => {
		const result = fixture();
		present(result.document.data.principals[0]).name =
			"Verified external author";
		expect(() => validateProviderConversion(result)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		const extra = fixture();
		extra.document.data.principals.push({ id: "outsider", name: "Private" });
		expect(() => validateProviderConversion(extra)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
	});

	test("refuses comments and assignments instead of silently exporting a subset", () => {
		const result = fixture();
		const taskId = present(result.document.data.tasks[0]).id;
		result.document.data.comments.push({
			id: "comment",
			taskId,
			authorId: result.document.sourceUserId,
			body: "private",
			createdAt: result.document.exportedAt,
			editedAt: null,
		});
		expect(() => exportTaskCsv(result)).toThrowError(
			new ProviderImportError("unsupported-content"),
		);
		const assigned = fixture();
		assigned.document.data.assignments.push({
			id: "assignment",
			taskId,
			userId: assigned.document.sourceUserId,
		});
		expect(() => validateProviderConversion(assigned)).toThrowError(
			new ProviderImportError("unsupported-content"),
		);
	});

	test("refuses recurrence and foreign operational list ownership", () => {
		const result = fixture();
		present(result.document.data.tasks[0]).rrule = "FREQ=DAILY";
		expect(() => validateProviderConversion(result)).toThrowError(
			new ProviderImportError("unsupported-content"),
		);
		const foreign = fixture();
		present(foreign.document.data.lists[0]).ownerId = "outsider";
		expect(() => validateProviderConversion(foreign)).toThrowError(
			new ProviderImportError("unsupported-content"),
		);
	});

	test("refuses unknown native fields and circular values without exposing content", () => {
		const result = fixture();
		Object.assign(present(result.document.data.tasks[0]), {
			token: "PRIVATE-SECRET",
		});
		expect(() => validateProviderConversion(result)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		const circular = fixture();
		Object.assign(circular.document, { circular: circular.document });
		expect(() => validateProviderConversion(circular)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
	});

	test("export is cancellable and refuses lossy noncanonical conversion evidence", () => {
		const result = fixture();
		const controller = new AbortController();
		controller.abort();
		expect(() =>
			exportTaskCsv(result, { signal: controller.signal }),
		).toThrowError(new ProviderImportError("cancelled"));
		present(result.document.data.workspaces[0]).name =
			"Modified workspace metadata";
		expect(() => exportTaskCsv(result)).toThrowError(
			new ProviderImportError("unsupported-content"),
		);
	});

	test("bounds expanded JSON bytes before serializing a large native document", () => {
		const result = fixture();
		const original = present(result.document.data.tasks[0]);
		const notes = "\u0001".repeat(32 * 1024 - 1);
		result.document.data.tasks = Array.from({ length: 1_000 }, (_, index) => ({
			...original,
			id: `${original.id}-${index}`,
			parentId: null,
			notes,
		}));
		expect(() => validateProviderConversion(result)).toThrowError(
			new ProviderImportError("byte-limit"),
		);
	});

	test("refuses undefined, accessor and executable native properties", () => {
		const result = fixture();
		Object.assign(result.document, { hidden: undefined });
		expect(() => validateProviderConversion(result)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		const getter = fixture();
		let accessed = false;
		Object.defineProperty(getter.document, "hidden", {
			enumerable: true,
			get: () => {
				accessed = true;
				return "private";
			},
		});
		expect(() => validateProviderConversion(getter)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		expect(accessed).toBe(false);
		const executable = fixture();
		Object.assign(executable.document, { toJSON: () => "private" });
		expect(() => validateProviderConversion(executable)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
	});
});
