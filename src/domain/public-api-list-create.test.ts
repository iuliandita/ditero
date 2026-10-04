import { expect, test } from "vitest";
import { PublicApiError } from "./public-api.ts";
import {
	apiListCreateSchema,
	apiListCreationAckSchema,
	canonicalApiListCreate,
	parseApiListCreate,
} from "./public-api-list-create.ts";
import {
	canonicalApiTaskCreate,
	parseApiTaskCreate,
} from "./public-api-writes.ts";

const input = { workspaceId: "workspace", title: "List", kind: "tasks" };

test("normalizes title and omitted icon without choosing a kind or guessing an icon", () => {
	expect(parseApiListCreate({ ...input, title: "  العربية  " })).toEqual({
		workspaceId: "workspace",
		title: "العربية",
		kind: "tasks",
		icon: null,
	});
	expect(
		apiListCreateSchema.safeParse({ workspaceId: "workspace", title: "List" })
			.success,
	).toBe(false);
	for (const kind of ["tasks", "shopping", "checklist", "project", "habits"])
		expect(parseApiListCreate({ ...input, kind }).kind).toBe(kind);
	for (const icon of ["shopping-basket", "🛒", "👨‍👩‍👧‍👦", "", " custom "])
		expect(parseApiListCreate({ ...input, icon }).icon).toBe(icon);
});

test("accepts boundary lengths and preserves supplied workspace identity", () => {
	const parsed = parseApiListCreate({
		workspaceId: "w".repeat(256),
		title: ` ${"a".repeat(500)} `,
		kind: "project",
		icon: "i".repeat(128),
	});
	expect(parsed.title).toHaveLength(500);
	expect(parsed.workspaceId).toHaveLength(256);
	expect(parsed.icon).toHaveLength(128);
});

test("canonicalizes equivalent fields in fixed order and separates list from task creation", () => {
	const first = parseApiListCreate({ ...input, title: "  List  " });
	const second = parseApiListCreate({
		icon: null,
		kind: "tasks",
		title: "List",
		workspaceId: "workspace",
	});
	expect(canonicalApiListCreate(first)).toBe(canonicalApiListCreate(second));
	expect(canonicalApiListCreate(first)).toBe(
		'{"operation":"list.create.v1","workspaceId":"workspace","title":"List","kind":"tasks","icon":null}',
	);
	expect(canonicalApiListCreate(first)).not.toBe(
		canonicalApiTaskCreate(
			parseApiTaskCreate({ listId: "workspace", title: "List" }),
		),
	);
	expect(
		canonicalApiListCreate(parseApiListCreate({ ...input, icon: "check" })),
	).not.toBe(canonicalApiListCreate(first));
});

test.each([
	null,
	false,
	"list",
	[],
	{},
	{ ...input, workspaceId: "" },
	{ ...input, workspaceId: "w".repeat(257) },
	{ ...input, title: " \t\n " },
	{ ...input, title: "a".repeat(501) },
	{ ...input, kind: undefined },
	{ ...input, kind: "Tasks" },
	{ ...input, kind: "notes" },
	{ ...input, icon: 1 },
	{ ...input, icon: "i".repeat(129) },
	{ ...input, id: "caller-id" },
	{ ...input, ownerId: "other" },
	{ ...input, sortKey: "a0" },
	{ ...input, folderId: "folder" },
	{ ...input, completedDisplay: "hide" },
	{ ...input, [Symbol("extra")]: true },
	JSON.parse(
		'{"workspaceId":"workspace","title":"List","kind":"tasks","__proto__":{}}',
	),
])("rejects inappropriate input with the stable invalid-list problem %j", (value) => {
	try {
		parseApiListCreate(value);
		throw new Error("Expected refusal");
	} catch (error) {
		expect(error).toBeInstanceOf(PublicApiError);
		expect(error).toMatchObject({ status: 400, code: "invalid-list" });
	}
});

test.each([
	"workspaceId",
	"title",
	"icon",
])("refuses NUL and malformed Unicode in %s", (field) => {
	for (const invalid of ["bad\0value", "bad\uD800", "\uDC00bad"])
		expect(() => parseApiListCreate({ ...input, [field]: invalid })).toThrow(
			PublicApiError,
		);
});

test("acknowledges an original list snapshot separately from a current-list DTO or API envelope", () => {
	const snapshot = {
		id: "list",
		workspaceId: "workspace",
		ownerId: "creator",
		title: "Original",
		kind: "shopping",
		icon: null,
		folderId: null,
		sortKey: "a0",
		completedDisplay: "sink",
	};
	const ack = { kind: "list-create-ack", snapshot };
	expect(apiListCreationAckSchema.parse(ack)).toEqual(ack);
	for (const invalid of [
		snapshot,
		{ ...ack, kind: "list" },
		{ ...ack, created: true },
		{ version: 1, data: ack, nextCursor: null },
		{ ...ack, snapshot: { ...snapshot, current: true } },
		{ ...ack, snapshot: { ...snapshot, ownerId: null } },
	])
		expect(apiListCreationAckSchema.safeParse(invalid).success).toBe(false);
});
