import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { hashImportValue } from "../import-digest.ts";
import { buildImportPlan } from "../import-plan.ts";
import { ProviderImportError, snapshotNamespace } from "./common.ts";
import {
	CSV_V1_EXCLUSIONS,
	PROVIDER_INPUT_MAX_BYTES,
	ProviderInputError,
	parseProviderBinding,
	parseProviderInput,
	prepareProviderImport,
	prepareProviderImportRequest,
	providerDocumentDigest,
	TRELLO_V1_EXCLUSIONS,
} from "./input.ts";

const namespace = "fcb28f31-12ae-4c9d-82f2-1289d9fcb411";
const otherNamespace = "73994b96-f20b-45bd-8808-379810a32ced";
const exportedAt = "2026-01-15T12:00:00.000Z";
const fixture = readFileSync(
	new URL(
		"../../../../tests/fixtures/portability/providers/csv-v1.csv",
		import.meta.url,
	),
);
function input(bytes: Uint8Array = fixture) {
	return {
		kind: "provider",
		version: 1,
		adapter: "ditero-csv",
		adapterVersion: 1,
		sourceNamespace: namespace,
		identityMode: "stable-ids",
		exclusions: [...CSV_V1_EXCLUSIONS],
		originalCsvBase64: Buffer.from(bytes).toString("base64"),
	};
}
function refusal(value: unknown, code = "invalid-input") {
	expect(() => parseProviderInput(value)).toThrowError(
		expect.objectContaining({ name: "ProviderInputError", code }),
	);
}

describe("provider original-input contract", () => {
	test("derives migration content and binding only from the original CSV", () => {
		const prepared = prepareProviderImport(input(), { exportedAt });
		expect(prepared.binding).toEqual({
			kind: "provider",
			version: 1,
			adapter: "ditero-csv",
			adapterVersion: 1,
			sourceNamespace: namespace,
			identityMode: "stable-ids",
			exclusions: CSV_V1_EXCLUSIONS,
		});
		expect(prepared.sourceFormat).toBe("ditero-csv");
		expect(prepared.sourceSchemaVersion).toBe(1);
		expect(prepared.originalBytes).toBe(fixture.length);
		expect(prepared.conversion.document.sourceUserId).toBe(
			`migration:ditero-csv:1:${namespace}:owner`,
		);
		expect(prepared.conversion.findings).toEqual([
			{ code: "untrusted-migration-owner", path: "sourceUserId" },
		]);
		expect(prepared.conversion.document.data.tasks).toHaveLength(2);
		expect(prepared.conversion.document.data.assignments).toEqual([]);
	});

	test.each([
		{ version: 2 },
		{ adapter: "todoist" },
		{ adapterVersion: 2 },
		{ identityMode: "snapshot" },
		{ sourceNamespace: namespace.toUpperCase() },
		{ sourceNamespace: "not-a-uuid" },
		{ document: "{}" },
		{ sourceUserId: "authenticated-user" },
		{ exclusions: [] },
		{ exclusions: [...CSV_V1_EXCLUSIONS].reverse() },
		{ exclusions: [...CSV_V1_EXCLUSIONS, "extra"] },
	])("refuses unknown or changed contract metadata %j", (change) =>
		refusal({ ...input(), ...change }));

	test("refuses missing fields and raw prototype keys before normalization", () => {
		const { adapter: _adapter, ...missing } = input();
		refusal(missing);
		refusal(
			JSON.parse(
				JSON.stringify(input()).replace('"kind":', '"__proto__":{},"kind":'),
			),
		);
		refusal({ ...input(), constructor: "private" });
		refusal(Object.assign(Object.create({ inherited: true }), input()));
		const accessor = input();
		Object.defineProperty(accessor, "adapter", {
			get: () => {
				throw new Error("must not run");
			},
		});
		refusal(accessor);
		refusal({ ...input(), [Symbol("extra")]: true });
	});

	test.each([
		"Zg",
		"Zh==",
		"Zg===",
		"Zg==\n",
		"_w==",
		"Zg==Zg==",
		"!AAA",
		"",
		"====",
	])("refuses noncanonical base64 %j", (value) =>
		refusal({ ...input(), originalCsvBase64: value }, "invalid-base64"));

	test("decodes canonical base64 across chunk boundaries", () => {
		const notes = "a".repeat(25_000);
		const bytes = new TextEncoder().encode(
			new TextDecoder()
				.decode(fixture)
				.replace("Bring bags, and check the pantry", notes)
				.replace("Buy apples,,", `Buy apples,${notes},`),
		);
		expect(input(bytes).originalCsvBase64.length).toBeGreaterThan(65_536);
		const prepared = prepareProviderImport(input(bytes), { exportedAt });
		expect(
			prepared.conversion.document.data.tasks.some(
				(task) => task.notes === notes,
			),
		).toBe(true);
	});

	test("rejects encoded byte excess before decoding or CSV processing", () => {
		refusal(
			{
				...input(),
				originalCsvBase64: "A".repeat(
					4 * Math.ceil((PROVIDER_INPUT_MAX_BYTES + 3) / 3),
				),
			},
			"byte-limit",
		);
		const exact = parseProviderInput(
			input(new Uint8Array(PROVIDER_INPUT_MAX_BYTES)),
		);
		if (!("originalCsvBase64" in exact)) throw new Error("Expected CSV input");
		expect(exact.originalCsvBase64.length).toBe(
			4 * Math.ceil(PROVIDER_INPUT_MAX_BYTES / 3),
		);
		refusal(input(new Uint8Array(PROVIDER_INPUT_MAX_BYTES + 1)), "byte-limit");
	});

	test("does not trust metadata that disagrees with the original CSV", () => {
		expect(() =>
			prepareProviderImport(
				{ ...input(), sourceNamespace: otherNamespace },
				{ exportedAt },
			),
		).toThrowError(expect.objectContaining({ code: "metadata-mismatch" }));
	});

	test("rejects invalid UTF-8 and unsupported CSV content without leaking cells", () => {
		expect(() =>
			prepareProviderImport(input(new Uint8Array([0xff])), { exportedAt }),
		).toThrowError(expect.objectContaining({ code: "invalid-encoding" }));
		const secret = "private-provider-cell";
		const bytes = new TextEncoder().encode(
			new TextDecoder().decode(fixture).replace("csv_version,", `${secret},`),
		);
		try {
			prepareProviderImport(input(bytes), { exportedAt });
			throw new Error("accepted");
		} catch (error) {
			expect(String(error)).not.toContain(secret);
			expect(error).toMatchObject({ code: "invalid-csv" });
		}
	});

	test("preserves cancellation and deadlines before conversion", () => {
		const controller = new AbortController();
		controller.abort();
		expect(() =>
			prepareProviderImport(input(), { exportedAt, signal: controller.signal }),
		).toThrowError("cancelled");
		expect(() =>
			prepareProviderImport(input(), {
				exportedAt,
				deadline: performance.now() - 1,
			}),
		).toThrowError("timeout");
	});

	test("shares the absolute deadline across input decoding and CSV validation", () => {
		const envelope = input();
		let now = 0;
		let atobCalls = 0;
		let postDeadlineValidations = 0;
		const decode = TextDecoder.prototype.decode;
		const encode = TextEncoder.prototype.encode;
		const originalAtob = globalThis.atob;
		try {
			vi.spyOn(performance, "now").mockImplementation(() => now);
			vi.spyOn(globalThis, "atob").mockImplementation((value) => {
				const result = originalAtob(value);
				atobCalls++;
				now = 14_000;
				return result;
			});
			vi.spyOn(TextDecoder.prototype, "decode").mockImplementation(function (
				this: TextDecoder,
				...args: Parameters<TextDecoder["decode"]>
			) {
				const result = decode.apply(this, args);
				now = 16_000;
				return result;
			});
			vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (
				this: TextEncoder,
				value?: string,
			) {
				if (now >= 15_000 && value === "Prepare groceries")
					postDeadlineValidations++;
				return encode.call(this, value);
			});
			expect(() =>
				prepareProviderImport(envelope, { exportedAt }),
			).toThrowError("timeout");
			expect(atobCalls).toBe(2);
			expect(postDeadlineValidations).toBe(0);
		} finally {
			vi.restoreAllMocks();
		}
	});

	test("validates stored bindings independently and rejects envelope fields", () => {
		const binding = prepareProviderImport(input(), { exportedAt }).binding;
		expect(parseProviderBinding(binding)).toEqual(binding);
		expect(() =>
			parseProviderBinding({ ...binding, originalCsvBase64: "Zg==" }),
		).toThrow(ProviderInputError);
		expect(() => parseProviderBinding({ ...binding, exclusions: [] })).toThrow(
			ProviderInputError,
		);
	});
});

describe("provider semantic document digest", () => {
	test("wraps the existing native digest and commits the exact binding", async () => {
		const { binding, conversion } = prepareProviderImport(input(), {
			exportedAt,
		});
		const plan = await buildImportPlan(conversion.document, {
			ownerUserId: "caller",
			sourceId: "saved-source",
			mappings: {
				workspaces: {
					[conversion.document.data.workspaces[0]?.id ?? ""]:
						"target-workspace",
				},
				principals: { [conversion.document.sourceUserId]: "caller" },
			},
		});
		const digest = await providerDocumentDigest(binding, plan.documentDigest);
		expect(digest).toBe(
			await hashImportValue(
				"ditero-import-provider-document-v1",
				{ binding, ordinaryDocumentDigest: plan.documentDigest },
				() => {},
			),
		);
		expect(digest).not.toBe(plan.documentDigest);
		expect(
			await providerDocumentDigest(
				{ ...binding, sourceNamespace: otherNamespace },
				plan.documentDigest,
			),
		).not.toBe(digest);
		expect(await providerDocumentDigest(binding, "a".repeat(64))).not.toBe(
			digest,
		);
		await expect(
			providerDocumentDigest(binding, "invalid"),
		).rejects.toMatchObject({ code: "invalid-digest" });
	});

	test("retains semantic equality across row reorder and export times", async () => {
		const lines = new TextDecoder().decode(fixture).trimEnd().split("\n");
		const reordered = new TextEncoder().encode(
			`${[lines[0], ...lines.slice(1).reverse()].join("\n")}\n`,
		);
		async function digest(bytes: Uint8Array, time: string) {
			const { binding, conversion } = prepareProviderImport(input(bytes), {
				exportedAt: time,
			});
			const plan = await buildImportPlan(conversion.document, {
				ownerUserId: "caller",
				sourceId: "source",
				mappings: {
					workspaces: {
						[conversion.document.data.workspaces[0]?.id ?? ""]: "workspace",
					},
					principals: { [conversion.document.sourceUserId]: "caller" },
				},
			});
			return providerDocumentDigest(binding, plan.documentDigest);
		}
		expect(await digest(fixture, exportedAt)).toBe(
			await digest(reordered, "2026-02-01T00:00:00.000Z"),
		);
	});
});

const TRELLO_BOARD = "64a1b2c3d4e5f60718293a4b";
const sha256 = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
const trelloFixture = readFileSync(
	new URL(
		"../../../../tests/fixtures/portability/providers/trello-board-v1.json",
		import.meta.url,
	),
);
function trelloBoardSha(boardId: string) {
	return sha256(`ditero-trello-board-v1\n${boardId}`);
}
function trelloInput(
	bytes: Uint8Array = trelloFixture,
	boardId = TRELLO_BOARD,
) {
	const boardIdSha256 = trelloBoardSha(boardId);
	return {
		kind: "provider",
		version: 1,
		adapter: "trello-board-json",
		adapterVersion: 1,
		sourceNamespace: snapshotNamespace(boardIdSha256),
		identityMode: "stable-ids",
		boardIdSha256,
		snapshotSha256: sha256(bytes),
		exclusions: [...TRELLO_V1_EXCLUSIONS],
		originalJsonBase64: Buffer.from(bytes).toString("base64"),
	};
}
type TrelloTestBoard = {
	id: string;
	cards: [Record<string, unknown>, ...Record<string, unknown>[]];
	lists: [Record<string, unknown>, ...Record<string, unknown>[]];
};
function trelloBytes(change: (board: TrelloTestBoard) => void) {
	const board = JSON.parse(trelloFixture.toString("utf8")) as TrelloTestBoard;
	change(board);
	return new TextEncoder().encode(JSON.stringify(board));
}
async function prepareRefusal(value: unknown, code: string, at = exportedAt) {
	const error: unknown = await prepareProviderImportRequest(value, {
		exportedAt: at,
	}).then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toMatchObject({ code });
	return error;
}

describe("Trello provider original-input contract", () => {
	test("derives conversion and binding only from the original board JSON", async () => {
		const prepared = await prepareProviderImportRequest(trelloInput(), {
			exportedAt,
		});
		const namespace = snapshotNamespace(trelloBoardSha(TRELLO_BOARD));
		expect(prepared.binding).toEqual({
			kind: "provider",
			version: 1,
			adapter: "trello-board-json",
			adapterVersion: 1,
			sourceNamespace: namespace,
			identityMode: "stable-ids",
			boardIdSha256: trelloBoardSha(TRELLO_BOARD),
			snapshotSha256: sha256(trelloFixture),
			exclusions: TRELLO_V1_EXCLUSIONS,
		});
		expect(prepared.sourceFormat).toBe("trello-board-json");
		expect(prepared.sourceSchemaVersion).toBe(1);
		expect(prepared.originalBytes).toBe(trelloFixture.length);
		expect(prepared.conversion.adapter).toBe("trello-board-json");
		expect(prepared.conversion.document.exportedAt).toBe(exportedAt);
		expect(prepared.conversion.document.sourceUserId).toBe(
			`migration:trello-board-json:1:${namespace}:owner`,
		);
		expect(prepared.conversion.findings).toEqual([
			{ code: "untrusted-migration-owner", path: "sourceUserId" },
		]);
	});

	test("ignored source metadata never becomes dates, completion, parents or grants", async () => {
		// The fixture carries due dates, members, labels and checklists.
		const { conversion } = await prepareProviderImportRequest(trelloInput(), {
			exportedAt,
		});
		const { data } = conversion.document;
		expect(data.tasks).toHaveLength(4);
		for (const task of data.tasks) {
			expect(task).toMatchObject({
				done: false,
				completedAt: null,
				dueAt: null,
				dueAllDay: false,
				parentId: null,
				rrule: null,
				fallbackUserId: null,
			});
		}
		expect(data.assignments).toEqual([]);
		expect(data.labels).toEqual([]);
		expect(data.comments).toEqual([]);
		expect(data.attachments).toEqual([]);
		expect(data.principals).toHaveLength(1);
	});

	test.each([
		{ version: 2 },
		{ adapter: "todoist-project-csv" },
		{ adapter: "ditero-csv" },
		{ adapterVersion: 2 },
		{ identityMode: "snapshot-rows" },
		{
			sourceNamespace: snapshotNamespace(
				trelloBoardSha(TRELLO_BOARD),
			).toUpperCase(),
		},
		{
			sourceNamespace: snapshotNamespace(
				trelloBoardSha("64a1b2c3d4e5f60718293a4c"),
			),
		},
		{ sourceNamespace: snapshotNamespace(sha256(trelloFixture)) },
		{ boardIdSha256: trelloBoardSha(TRELLO_BOARD).toUpperCase() },
		{ boardIdSha256: "abc" },
		{ snapshotSha256: sha256(trelloFixture).toUpperCase() },
		{ snapshotSha256: "abc" },
		{ exclusions: [] },
		{ exclusions: [...TRELLO_V1_EXCLUSIONS].reverse() },
		{ exclusions: [...TRELLO_V1_EXCLUSIONS, "extra"] },
		{ exclusions: TRELLO_V1_EXCLUSIONS.slice(0, -1) },
		{ document: "{}" },
		{ conversion: {} },
		{ sourceUserId: "authenticated-user" },
		{ projectFolderName: "Board" },
		{ originalCsvBase64: "Zg==" },
	])("refuses unknown or changed Trello contract metadata %j", (change) =>
		refusal({ ...trelloInput(), ...change }));

	test("keeps the CSV and Trello payload fields exclusive", () => {
		const { originalJsonBase64, ...withoutPayload } = trelloInput();
		refusal(withoutPayload);
		refusal({ ...withoutPayload, originalCsvBase64: originalJsonBase64 });
		const { originalCsvBase64, ...csv } = input();
		refusal({ ...csv, originalJsonBase64: originalCsvBase64 });
		expect(parseProviderInput(input())).toMatchObject({
			adapter: "ditero-csv",
		});
	});

	test("refuses prototype keys, accessors, inherited and symbol keys", () => {
		refusal(
			JSON.parse(
				JSON.stringify(trelloInput()).replace(
					'"kind":',
					'"__proto__":{},"kind":',
				),
			),
		);
		refusal(Object.assign(Object.create({ inherited: true }), trelloInput()));
		const accessor = trelloInput();
		Object.defineProperty(accessor, "boardIdSha256", {
			get: () => {
				throw new Error("must not run");
			},
		});
		refusal(accessor);
		refusal({ ...trelloInput(), [Symbol("extra")]: true });
		const exclusions = trelloInput();
		Object.defineProperty(exclusions.exclusions, "0", {
			get: () => "dates",
			enumerable: true,
		});
		refusal(exclusions);
	});

	test.each([
		"Zg",
		"Zh==",
		"Zg===",
		"Zg==\n",
		"_w==",
		"Zg==Zg==",
		"",
		"====",
	])("refuses noncanonical base64 %j", (value) =>
		refusal({ ...trelloInput(), originalJsonBase64: value }, "invalid-base64"));

	test("bounds raw bytes at 23 MiB and the encoded request below 32 MiB", () => {
		const exact = parseProviderInput(
			trelloInput(new Uint8Array(PROVIDER_INPUT_MAX_BYTES)),
		);
		expect(
			"originalJsonBase64" in exact && exact.originalJsonBase64.length,
		).toBe(4 * Math.ceil(PROVIDER_INPUT_MAX_BYTES / 3));
		expect(4 * Math.ceil(PROVIDER_INPUT_MAX_BYTES / 3)).toBeLessThanOrEqual(
			32 * 1024 * 1024,
		);
		refusal(
			trelloInput(new Uint8Array(PROVIDER_INPUT_MAX_BYTES + 1)),
			"byte-limit",
		);
		refusal(
			{
				...trelloInput(),
				originalJsonBase64: "A".repeat(
					4 * Math.ceil((PROVIDER_INPUT_MAX_BYTES + 3) / 3),
				),
			},
			"byte-limit",
		);
	});

	test("does not trust a claimed snapshot, board or namespace", async () => {
		await prepareRefusal(
			{ ...trelloInput(), snapshotSha256: "a".repeat(64) },
			"metadata-mismatch",
		);
		// An internally consistent binding for another board still disagrees with the bytes.
		const other = trelloInput(trelloFixture, "64a1b2c3d4e5f60718293a4c");
		await prepareRefusal(other, "metadata-mismatch");
		await prepareRefusal(
			{ ...trelloInput(), boardIdSha256: "b".repeat(64) },
			"invalid-input",
		);
	});

	test("a re-export with the same ids keeps identity but changes the snapshot", async () => {
		const edited = trelloBytes((board) => {
			board.cards[0].name = "Write the revised plan";
		});
		const first = await prepareProviderImportRequest(trelloInput(), {
			exportedAt,
		});
		const second = await prepareProviderImportRequest(trelloInput(edited), {
			exportedAt,
		});
		expect(second.binding.sourceNamespace).toBe(first.binding.sourceNamespace);
		expect(second.conversion.document.sourceUserId).toBe(
			first.conversion.document.sourceUserId,
		);
		expect(
			second.conversion.document.data.tasks.map((task) => task.id),
		).toEqual(first.conversion.document.data.tasks.map((task) => task.id));
		expect(second.binding).not.toEqual(first.binding);
		expect(
			"snapshotSha256" in second.binding && second.binding.snapshotSha256,
		).toBe(sha256(edited));
		// The old claimed fingerprint cannot be attached to the changed bytes.
		await prepareRefusal(
			{ ...trelloInput(edited), snapshotSha256: sha256(trelloFixture) },
			"metadata-mismatch",
		);
		expect(
			await providerDocumentDigest(first.binding, "a".repeat(64)),
		).not.toBe(await providerDocumentDigest(second.binding, "a".repeat(64)));
	});

	test.each([
		[
			"archived card",
			(board: TrelloTestBoard) => (board.cards[0].closed = true),
			"unsupported-content",
		],
		[
			"archived list",
			(board: TrelloTestBoard) => (board.lists[0].closed = true),
			"unsupported-content",
		],
		[
			"completed due date",
			(board: TrelloTestBoard) => (board.cards[0].dueComplete = true),
			"unsupported-content",
		],
		[
			"template card",
			(board: TrelloTestBoard) => (board.cards[0].isTemplate = true),
			"unsupported-content",
		],
		[
			"card role",
			(board: TrelloTestBoard) => (board.cards[0].cardRole = "mirror"),
			"unsupported-content",
		],
		[
			"card on a foreign board",
			(board: TrelloTestBoard) =>
				(board.cards[0].idBoard = "64a1b2c3d4e5f60718293aff"),
			"invalid-graph",
		],
		[
			"card on an unknown list",
			(board: TrelloTestBoard) =>
				(board.cards[0].idList = "64a1b2c3d4e5f60718293aff"),
			"invalid-graph",
		],
		[
			"parent reference",
			(board: TrelloTestBoard) =>
				(board.cards[0].idParent = "64a1b2c3d4e5f60718293b02"),
			null,
		],
	])("converts or refuses unsafe board content: %s", async (_name, change, code) => {
		const bytes = trelloBytes(change);
		if (code === null) {
			// Unknown card fields are ignored metadata and never create a parent.
			const { conversion } = await prepareProviderImportRequest(
				trelloInput(bytes),
				{
					exportedAt,
				},
			);
			expect(
				conversion.document.data.tasks.every((task) => task.parentId === null),
			).toBe(true);
			return;
		}
		await prepareRefusal(trelloInput(bytes), code);
	});

	test("refuses invalid encodings and JSON without leaking content", async () => {
		await prepareRefusal(
			trelloInput(new Uint8Array([0xff])),
			"invalid-encoding",
		);
		await prepareRefusal(
			trelloInput(new Uint8Array([0xef, 0xbb, 0xbf, ...trelloFixture])),
			"invalid-json",
		);
		const secret = "private-provider-cell";
		const error = await prepareRefusal(
			trelloInput(new TextEncoder().encode(`{"id":"${secret}"`)),
			"invalid-json",
		);
		expect(String(error)).not.toContain(secret);
		const wrongId = await prepareRefusal(
			trelloInput(trelloBytes((board) => (board.id = secret))),
			"invalid-row",
		);
		expect(String(wrongId)).not.toContain(secret);
	});

	test("validates the supplied export time instead of accepting loose dates", async () => {
		for (const at of [
			"2026-01-15",
			"2026-01-15T12:00:00+02:00",
			"yesterday",
			"",
		])
			await prepareRefusal(trelloInput(), "invalid-result", at);
	});

	test("preserves cancellation and the absolute deadline", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			prepareProviderImportRequest(trelloInput(), {
				exportedAt,
				signal: controller.signal,
			}),
		).rejects.toThrowError("cancelled");
		await expect(
			prepareProviderImportRequest(trelloInput(), {
				exportedAt,
				deadline: performance.now() - 1,
			}),
		).rejects.toThrowError("timeout");
	});

	test("reports provider conversion failures as provider errors", async () => {
		const error: unknown = await prepareProviderImportRequest(
			trelloInput(trelloBytes((board) => (board.cards[0].closed = true))),
			{ exportedAt },
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ProviderImportError);
	});

	test("validates stored Trello bindings independently and rejects envelope fields", async () => {
		const { binding } = await prepareProviderImportRequest(trelloInput(), {
			exportedAt,
		});
		expect(parseProviderBinding(binding)).toEqual(binding);
		for (const forged of [
			{ ...binding, originalJsonBase64: "Zg==" },
			{ ...binding, exclusions: [] },
			{ ...binding, sourceNamespace: otherNamespace },
			{ ...binding, boardIdSha256: "b".repeat(64) },
			{ ...binding, boardIdSha256: "ABC" },
			{ ...binding, boardIdSha256: trelloBoardSha(TRELLO_BOARD).toUpperCase() },
			{ ...binding, snapshotSha256: undefined },
			{ ...binding, projectFolderName: "Board" },
			{ ...binding, identityMode: "snapshot-rows" },
		])
			expect(() => parseProviderBinding(forged)).toThrow(ProviderInputError);
	});

	test("commits the board identity and snapshot into the provider digest", async () => {
		const { binding } = await prepareProviderImportRequest(trelloInput(), {
			exportedAt,
		});
		const digest = await providerDocumentDigest(binding, "a".repeat(64));
		expect(digest).toBe(
			await hashImportValue(
				"ditero-import-provider-document-v1",
				{ binding, ordinaryDocumentDigest: "a".repeat(64) },
				() => {},
			),
		);
		for (const change of [
			{ snapshotSha256: "c".repeat(64) },
			{ boardIdSha256: trelloBoardSha("64a1b2c3d4e5f60718293a4c") },
		]) {
			const changed = { ...binding, ...change };
			if (change.boardIdSha256 !== undefined)
				changed.sourceNamespace = snapshotNamespace(change.boardIdSha256);
			expect(await providerDocumentDigest(changed, "a".repeat(64))).not.toBe(
				digest,
			);
		}
		await expect(
			providerDocumentDigest(
				{ ...binding, boardIdSha256: "x" },
				"a".repeat(64),
			),
		).rejects.toThrow(ProviderInputError);
	});

	test("leaves the CSV request path unchanged", async () => {
		const prepared = await prepareProviderImportRequest(input(), {
			exportedAt,
		});
		expect(prepared.sourceFormat).toBe("ditero-csv");
		expect(prepared.binding).toEqual({
			kind: "provider",
			version: 1,
			adapter: "ditero-csv",
			adapterVersion: 1,
			sourceNamespace: namespace,
			identityMode: "stable-ids",
			exclusions: CSV_V1_EXCLUSIONS,
		});
	});
});
