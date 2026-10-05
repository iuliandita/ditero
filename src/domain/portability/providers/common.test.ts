import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { PortableRows } from "../v1.ts";
import {
	ProviderImportError,
	TRELLO_ADAPTER,
	validateProviderConversion,
} from "./common.ts";
import { exportTaskCsv, parseTaskCsv } from "./csv.ts";
import { parseTrelloBoardJson } from "./trello.ts";

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

function trelloFixture() {
	return parseTrelloBoardJson(
		readFileSync(
			new URL(
				"../../../../tests/fixtures/portability/providers/trello-board-v1.json",
				import.meta.url,
			),
		),
		{ exportedAt: "2026-01-15T12:00:00.000Z" },
	);
}

describe("Trello provider conversion evidence", () => {
	test("requires the exact versioned stable-identity contract", async () => {
		const result = await trelloFixture();
		expect(validateProviderConversion(result)).toEqual(result);
		const { boardIdSha256: _omitted, ...withoutBoardHash } = result;
		for (const modified of [
			{ ...result, adapterVersion: 2 },
			{ ...result, identityMode: "snapshot-rows" },
			{ ...result, findings: [] },
			{ ...result, token: "private" },
			{ ...result, snapshotSha256: "not-a-hash" },
			{ ...result, boardIdSha256: "0".repeat(64) },
			withoutBoardHash,
		])
			expect(() => validateProviderConversion(modified)).toThrowError(
				new ProviderImportError("invalid-result"),
			);
		const csv = fixture();
		expect(() =>
			validateProviderConversion({ ...csv, adapter: TRELLO_ADAPTER }),
		).toThrowError(new ProviderImportError("invalid-result"));
		expect(() =>
			validateProviderConversion({ ...csv, boardIdSha256: "0".repeat(64) }),
		).toThrowError(new ProviderImportError("invalid-result"));
	});

	test("refuses owner or namespace substitution", async () => {
		const owner = await trelloFixture();
		owner.document.sourceUserId = "signed-in-user";
		expect(() => validateProviderConversion(owner)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		const namespace = await trelloFixture();
		namespace.sourceNamespace = "fcb28f31-12ae-4c9d-82f2-1289d9fcb412";
		expect(() => validateProviderConversion(namespace)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		const principal = await trelloFixture();
		present(principal.document.data.principals[0]).name = "Verified author";
		expect(() => validateProviderConversion(principal)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
	});

	test("refuses a changed board folder or foreign folder placement", async () => {
		const blank = await trelloFixture();
		present(blank.document.data.folders[0]).name = " ";
		expect(() => validateProviderConversion(blank)).toThrowError(
			new ProviderImportError("invalid-result"),
		);
		const missing = await trelloFixture();
		missing.document.data.folders = [];
		const extra = await trelloFixture();
		extra.document.data.folders.push({
			id: "other",
			workspaceId: present(extra.document.data.folders[0]).workspaceId,
			name: "Other",
			sortKey: "a1",
		});
		const foreign = await trelloFixture();
		present(foreign.document.data.folders[0]).workspaceId = "outsider";
		const unfiled = await trelloFixture();
		present(unfiled.document.data.lists[0]).folderId = null;
		for (const modified of [missing, extra, foreign, unfiled])
			expect(() => validateProviderConversion(modified)).toThrowError(
				new ProviderImportError("unsupported-content"),
			);
	});

	test("refuses non-Trello row identities and unsupported task state", async () => {
		const listId = await trelloFixture();
		const list = present(listId.document.data.lists[0]);
		list.id = list.id.replace(/:list:.*$/, ":list:record:1");
		const foreignList = await trelloFixture();
		present(foreignList.document.data.lists[0]).ownerId = "outsider";
		const taskId = await trelloFixture();
		const task = present(taskId.document.data.tasks[0]);
		task.id = task.id.replace(/:task:.*$/, ":task:record:1");
		const mutations: ((row: PortableRows["tasks"]) => void)[] = [
			(row) => {
				row.done = true;
			},
			(row) => {
				row.completedAt = "2026-01-01T00:00:00.000Z";
			},
			(row) => {
				row.dueAt = "2026-02-01T10:00:00.000Z";
			},
			(row) => {
				row.dueAllDay = true;
			},
			(row) => {
				row.priority = 1;
			},
			(row) => {
				row.rrule = "FREQ=DAILY";
			},
			(row) => {
				row.parentId = "trello-parent";
			},
		];
		for (const mutate of mutations) {
			const modified = await trelloFixture();
			mutate(present(modified.document.data.tasks[0]));
			expect(() => validateProviderConversion(modified)).toThrowError(
				new ProviderImportError("unsupported-content"),
			);
		}
		for (const modified of [listId, foreignList, taskId])
			expect(() => validateProviderConversion(modified)).toThrowError(
				new ProviderImportError("unsupported-content"),
			);
	});

	test("refuses imported collaboration rows and cancels on request", async () => {
		const assigned = await trelloFixture();
		assigned.document.data.assignments.push({
			id: "assignment",
			taskId: present(assigned.document.data.tasks[0]).id,
			userId: assigned.document.sourceUserId,
		});
		expect(() => validateProviderConversion(assigned)).toThrowError(
			new ProviderImportError("unsupported-content"),
		);
		const controller = new AbortController();
		controller.abort();
		expect(() =>
			validateProviderConversion(assigned, { signal: controller.signal }),
		).toThrowError(new ProviderImportError("cancelled"));
	});
});
