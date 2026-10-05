import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	PROVIDER_MAX_BYTES,
	PROVIDER_MAX_FIELD_BYTES,
	type ProviderImportCode,
	ProviderImportError,
	snapshotNamespace,
	TRELLO_ADAPTER,
	TRELLO_V1_EXCLUSIONS,
	validateProviderConversion,
} from "./common.ts";
import { parseTrelloBoardJson, trelloSnapshotSha256 } from "./trello.ts";

const options = { exportedAt: "2026-01-15T12:00:00.000Z" };
const encoder = new TextEncoder();
const BOARD = "64a1b2c3d4e5f60718293a4b";
const LIST = "64a1b2c3d4e5f60718293a01";
const CARD = "64a1b2c3d4e5f60718293b01";

function list(overrides: Record<string, unknown> = {}) {
	return {
		id: LIST,
		idBoard: BOARD,
		name: "To do",
		closed: false,
		pos: 1,
		...overrides,
	};
}
function card(overrides: Record<string, unknown> = {}) {
	return {
		id: CARD,
		idBoard: BOARD,
		idList: LIST,
		name: "Card",
		desc: "",
		closed: false,
		pos: 1,
		...overrides,
	};
}
function board(overrides: Record<string, unknown> = {}) {
	return {
		id: BOARD,
		name: "Board",
		closed: false,
		lists: [list()],
		cards: [card()],
		...overrides,
	};
}
// JSON.stringify drops undefined values, so an undefined override removes a key.
function bytes(value: unknown): Uint8Array {
	return encoder.encode(
		typeof value === "string" ? value : JSON.stringify(value),
	);
}
function fixtureBytes(): Uint8Array {
	return readFileSync(
		new URL(
			"../../../../tests/fixtures/portability/providers/trello-board-v1.json",
			import.meta.url,
		),
	);
}
function present<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing fixture row");
	return value;
}
async function refuses(
	input: Uint8Array,
	code: ProviderImportCode,
	extra: Record<string, unknown> = {},
) {
	const error: unknown = await parseTrelloBoardJson(input, {
		...options,
		...extra,
	}).then(
		() => null,
		(error: unknown) => error,
	);
	expect(error).toBeInstanceOf(ProviderImportError);
	expect(error).toMatchObject({ code });
}
const sha256 = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
const expectedNamespace = (boardId: string) =>
	snapshotNamespace(sha256(`ditero-trello-board-v1\n${boardId}`));

describe("Trello board JSON conversion", () => {
	test("converts the synthetic documented board into an ordered operational list tree", async () => {
		const raw = fixtureBytes();
		const result = await parseTrelloBoardJson(raw, options);
		const namespace = expectedNamespace(BOARD);
		const prefix = `trello:1:${namespace}`;
		const { data } = result.document;
		expect(result.adapter).toBe(TRELLO_ADAPTER);
		expect(result.adapterVersion).toBe(1);
		expect(result.identityMode).toBe("stable-ids");
		expect(result.sourceNamespace).toBe(namespace);
		expect(result.boardIdSha256).toBe(
			sha256(`ditero-trello-board-v1\n${BOARD}`),
		);
		expect(result.snapshotSha256).toBe(sha256(raw));
		expect(result.findings).toEqual([
			{ code: "untrusted-migration-owner", path: "sourceUserId" },
		]);
		expect(result.document.sourceUserId).toBe(
			`migration:trello-board-json:1:${namespace}:owner`,
		);
		expect(data.workspaces.map(({ kind }) => kind)).toEqual(["personal"]);
		expect(data.folders).toEqual([
			{
				id: `${prefix}:folder:board`,
				workspaceId: `${prefix}:workspace`,
				name: "Launch board",
				sortKey: "a0",
			},
		]);
		expect(data.lists.map(({ id, title }) => [id, title])).toEqual([
			[`${prefix}:list:64a1b2c3d4e5f60718293a02`, "Doing ünïcode ✓"],
			[`${prefix}:list:${LIST}`, "To do"],
			[`${prefix}:list:64a1b2c3d4e5f60718293a03`, "Done"],
		]);
		for (const row of data.lists) {
			expect(row.kind).toBe("tasks");
			expect(row.completedDisplay).toBe("sink");
			expect(row.folderId).toBe(`${prefix}:folder:board`);
			expect(row.ownerId).toBe(result.document.sourceUserId);
		}
		const keys = data.lists.map(({ sortKey }) => sortKey);
		expect(keys).toEqual([...keys].sort());
		expect(
			data.tasks.map(({ id, title, notes }) => [id, title, notes]),
		).toEqual([
			[
				`${prefix}:task:64a1b2c3d4e5f60718293b03`,
				"Draft \u{1f4dd}",
				"Markup such as <b>bold</b> stays literal text.",
			],
			[`${prefix}:task:64a1b2c3d4e5f60718293b02`, "Review", null],
			[`${prefix}:task:${CARD}`, "Write plan", "Line one\nLine two"],
			[`${prefix}:task:64a1b2c3d4e5f60718293b04`, "Ship it", null],
		]);
		const [review, write] = [data.tasks[1], data.tasks[2]].map(present);
		expect(review.listId).toBe(write.listId);
		expect(review.sortKey < write.sortKey).toBe(true);
		for (const task of data.tasks) {
			expect(task).toMatchObject({
				parentId: null,
				priority: 0,
				done: false,
				completedAt: null,
				dueAt: null,
				dueAllDay: false,
				rrule: null,
				urgent: false,
			});
		}
		expect(validateProviderConversion(result)).toEqual(result);
	});

	test("discloses but never imports dates, labels, members, checklists or history", async () => {
		const result = await parseTrelloBoardJson(fixtureBytes(), options);
		const serialized = JSON.stringify(result);
		for (const ignored of [
			"2026-02-01",
			"Urgent",
			"Example Person",
			"Disclosed as ignored",
			"Board description",
			"x-fixture-note",
		])
			expect(serialized).not.toContain(ignored);
		for (const key of [
			"labels",
			"taskLabels",
			"assignments",
			"comments",
			"templates",
			"habitLogs",
			"attachments",
		] as const)
			expect(result.document.data[key]).toEqual([]);
	});

	test("keeps the fixed ordered exclusion binding constant", () => {
		expect(TRELLO_V1_EXCLUSIONS).toEqual([
			"dates",
			"completion-state",
			"recurrence",
			"authors",
			"assignments",
			"comments",
			"labels",
			"checklists",
			"attachments",
			"history",
			"reminders",
			"personal-state",
			"custom-fields",
			"covers",
			"stickers",
			"view-settings",
			"plugin-data",
			"task-creation-times",
			"shopping-fields",
			"urgency",
			"board-descriptions",
		]);
		expect(Object.isFrozen(TRELLO_V1_EXCLUSIONS)).toBe(true);
	});

	test("is stable across re-export ordering, spacing, ID case and unsupported content", async () => {
		const first = await parseTrelloBoardJson(fixtureBytes(), options);
		const source = JSON.parse(new TextDecoder().decode(fixtureBytes()));
		const reexport = {
			cards: [...source.cards]
				.reverse()
				.map((value: Record<string, unknown>) => ({
					...value,
					id: String(value.id).toUpperCase(),
					labels: [{ name: "different unsupported content" }],
					due: null,
				})),
			lists: [...source.lists].reverse(),
			closed: false,
			name: source.name,
			id: BOARD.toUpperCase(),
			actions: [],
		};
		const raw = bytes(JSON.stringify(reexport, null, 4));
		const second = await parseTrelloBoardJson(raw, options);
		expect(second.document).toEqual(first.document);
		expect(second.sourceNamespace).toBe(first.sourceNamespace);
		expect(second.boardIdSha256).toBe(first.boardIdSha256);
		// The fingerprint covers the exact bytes, so it differs while identity holds.
		expect(second.snapshotSha256).not.toBe(first.snapshotSha256);
		expect(second.snapshotSha256).toBe(sha256(raw));
	});

	test("breaks position ties by canonical ID and orders by numeric position", async () => {
		const a = "64a1b2c3d4e5f60718293b0a";
		const b = "64a1b2c3d4e5f60718293b0b";
		const c = "64a1b2c3d4e5f60718293b0c";
		const result = await parseTrelloBoardJson(
			bytes(
				board({
					cards: [
						card({ id: c, name: "ten", pos: 10 }),
						card({ id: b.toUpperCase(), name: "tie b", pos: 2 }),
						card({ id: a, name: "tie a", pos: 2 }),
					],
				}),
			),
			options,
		);
		expect(result.document.data.tasks.map(({ title }) => title)).toEqual([
			"tie a",
			"tie b",
			"ten",
		]);
	});

	test("keeps names and notes literal without normalization or markup handling", async () => {
		const title = "Café <script>alert(1)</script>";
		const notes = "  keep spacing \r\n [link](https://example.invalid)  ";
		const result = await parseTrelloBoardJson(
			bytes(board({ cards: [card({ name: title, desc: notes })] })),
			options,
		);
		const task = present(result.document.data.tasks[0]);
		expect(task.title).toBe(title);
		expect(task.notes).toBe(notes);
	});

	test("derives identity from the board ID only", async () => {
		const other = "64a1b2c3d4e5f60718293a4c";
		const first = await parseTrelloBoardJson(bytes(board()), options);
		const renamed = await parseTrelloBoardJson(
			bytes(board({ name: "Renamed", cards: [] })),
			options,
		);
		const different = await parseTrelloBoardJson(
			bytes(
				board({
					id: other,
					lists: [list({ idBoard: other })],
					cards: [card({ idBoard: other })],
				}),
			),
			options,
		);
		expect(renamed.sourceNamespace).toBe(first.sourceNamespace);
		expect(different.sourceNamespace).toBe(expectedNamespace(other));
		expect(different.sourceNamespace).not.toBe(first.sourceNamespace);
	});

	test("accepts absent or false completion and template flags", async () => {
		for (const extra of [
			{},
			{ dueComplete: false },
			{ isTemplate: false },
			{ cardRole: null },
			{ due: "2026-03-01T00:00:00.000Z", dueComplete: false },
		]) {
			const result = await parseTrelloBoardJson(
				bytes(board({ cards: [card(extra)] })),
				options,
			);
			expect(present(result.document.data.tasks[0]).done).toBe(false);
		}
	});

	test("rejects archived content and completion, template or special-card ambiguity", async () => {
		for (const input of [
			board({ closed: true }),
			board({ lists: [list({ closed: true })] }),
			board({ cards: [card({ closed: true })] }),
			board({ cards: [card({ dueComplete: true })] }),
			board({ cards: [card({ isTemplate: true })] }),
			board({ cards: [card({ cardRole: "separator" })] }),
			board({ cards: [card({ cardRole: "mirror" })] }),
			board({ cards: [card({ cardRole: "link" })] }),
			board({ cards: [card({ cardRole: "board" })] }),
		])
			await refuses(bytes(input), "unsupported-content");
		for (const input of [
			board({ closed: undefined }),
			board({ closed: "false" }),
			board({ lists: [list({ closed: undefined })] }),
			board({ cards: [card({ closed: 0 })] }),
			board({ cards: [card({ dueComplete: "true" })] }),
			board({ cards: [card({ isTemplate: null })] }),
		])
			await refuses(bytes(input), "invalid-row");
	});

	test("rejects invalid Trello IDs", async () => {
		for (const bad of [
			undefined,
			null,
			5,
			"",
			"abc",
			"g".repeat(24),
			`${CARD}0`,
		])
			for (const input of [
				board({ id: bad }),
				board({ lists: [list({ id: bad })] }),
				board({ cards: [card({ id: bad })] }),
				board({ cards: [card({ idList: bad })] }),
				board({ lists: [list({ idBoard: bad })] }),
				board({ cards: [card({ idBoard: bad })] }),
			])
				await refuses(bytes(input), "invalid-row");
	});

	test("rejects duplicate entity IDs, including by case", async () => {
		const second = list({ pos: 2 });
		for (const input of [
			board({ lists: [list(), second] }),
			board({ lists: [list(), { ...second, id: LIST.toUpperCase() }] }),
			board({ cards: [card(), card({ pos: 2 })] }),
			board({ cards: [card(), card({ id: CARD.toUpperCase() })] }),
		])
			await refuses(bytes(input), "invalid-graph");
	});

	test("rejects foreign board and list references", async () => {
		const foreign = "64a1b2c3d4e5f60718293a99";
		for (const input of [
			board({ lists: [list({ idBoard: foreign })] }),
			board({ cards: [card({ idBoard: foreign })] }),
			board({ cards: [card({ idList: foreign })] }),
		])
			await refuses(bytes(input), "invalid-graph");
		await refuses(
			bytes(board({ lists: [list({ idBoard: undefined })] })),
			"invalid-row",
		);
		await refuses(
			bytes(board({ cards: [card({ idList: undefined })] })),
			"invalid-row",
		);
	});

	test("rejects malformed names, notes and positions", async () => {
		for (const input of [
			board({ name: undefined }),
			board({ name: 5 }),
			board({ name: "  \t" }),
			board({ lists: [list({ name: "" })] }),
			board({ cards: [card({ name: undefined })] }),
			board({ cards: [card({ name: "  " })] }),
			board({ cards: [card({ desc: null })] }),
			board({ cards: [card({ desc: 5 })] }),
			board({ lists: [list({ pos: "1" })] }),
			board({ lists: [list({ pos: undefined })] }),
			board({ lists: [list({ pos: null })] }),
			board({ cards: [card({ pos: "top" })] }),
			board({ cards: [card({ pos: undefined })] }),
			board({ cards: [card({ name: "bad\u0000name" })] }),
			board({ cards: [card({ desc: "bad\ud800" })] }),
		])
			await refuses(bytes(input), "invalid-row");
	});

	test("rejects non-finite positions that JSON would turn into infinity", async () => {
		await refuses(
			bytes(
				`{"id":"${BOARD}","name":"B","closed":false,"lists":[{"id":"${LIST}","idBoard":"${BOARD}","name":"L","closed":false,"pos":1e999}],"cards":[]}`,
			),
			"invalid-json",
		);
	});

	test("rejects malformed JSON, encoding and root shapes", async () => {
		await refuses(bytes("{"), "invalid-json");
		await refuses(bytes(""), "invalid-json");
		await refuses(bytes(`﻿${JSON.stringify(board())}`), "invalid-json");
		await refuses(new Uint8Array([0x7b, 0xff, 0x7d]), "invalid-encoding");
		for (const input of ["[]", "null", "5", '"text"'])
			await refuses(bytes(input), "invalid-metadata");
		await refuses(bytes(board({ lists: undefined })), "invalid-metadata");
		await refuses(bytes(board({ cards: {} })), "invalid-metadata");
		await refuses(bytes(board({ lists: [5] })), "invalid-row");
		await refuses(bytes(board({ cards: [[]] })), "invalid-row");
	});

	test("ignores inherited-looking keys instead of reading prototype values", async () => {
		const raw = `{"id":"${BOARD}","name":"B","closed":false,"lists":[],"cards":[],"__proto__":{"closed":true},"constructor":{"name":"x"}}`;
		const result = await parseTrelloBoardJson(bytes(raw), options);
		expect(result.document.data.lists).toEqual([]);
		await refuses(
			bytes(`{"id":"${BOARD}","closed":false,"lists":[],"cards":[]}`),
			"invalid-row",
		);
	});

	test("bounds names and notes by the provider field limits", async () => {
		await parseTrelloBoardJson(
			bytes(
				board({
					name: "n".repeat(500),
					cards: [
						card({
							name: "t".repeat(500),
							desc: "d".repeat(PROVIDER_MAX_FIELD_BYTES - 1),
						}),
					],
				}),
			),
			options,
		);
		for (const input of [
			board({ name: "n".repeat(501) }),
			board({ lists: [list({ name: "ü".repeat(251) })] }),
			board({ cards: [card({ name: "t".repeat(501) })] }),
			board({ cards: [card({ desc: "d".repeat(PROVIDER_MAX_FIELD_BYTES) })] }),
		])
			await refuses(bytes(input), "field-limit");
	});

	test("bounds input bytes and row counts before conversion", async () => {
		await refuses(new Uint8Array(PROVIDER_MAX_BYTES + 1), "byte-limit");
		await expect(
			trelloSnapshotSha256(new Uint8Array(PROVIDER_MAX_BYTES + 1)),
		).rejects.toThrowError(new ProviderImportError("byte-limit"));
		await refuses(
			bytes(board({ cards: new Array(49_998).fill({}) })),
			"row-limit",
		);
		await refuses(
			bytes(board({ lists: new Array(50_000).fill({}), cards: [] })),
			"row-limit",
		);
	});

	test("honors cancellation, deadlines and strict options", async () => {
		const controller = new AbortController();
		controller.abort();
		await refuses(bytes(board()), "cancelled", { signal: controller.signal });
		await refuses(bytes(board()), "timeout", {
			deadline: performance.now() - 1,
		});
		await refuses(bytes(board()), "timeout", { deadline: Number.NaN });
		await refuses(bytes(board()), "invalid-metadata", { token: "private" });
		await expect(
			trelloSnapshotSha256(bytes(board()), { signal: controller.signal }),
		).rejects.toThrowError(new ProviderImportError("cancelled"));
		await expect(
			parseTrelloBoardJson(bytes(board()), null as never),
		).rejects.toThrowError(new ProviderImportError("invalid-metadata"));
	});
});
