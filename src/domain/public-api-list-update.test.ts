import { expect, test } from "vitest";
import { listStateToken } from "../server/public-api/list-observation.ts";
import { PublicApiError } from "./public-api.ts";
import {
	apiListObservationSchema,
	apiListUpdateAckSchema,
	canonicalApiListSnapshot,
	canonicalApiListUpdate,
	parseApiListUpdate,
} from "./public-api-list-update.ts";

const input = {
	workspaceId: "workspace",
	expectedState: "a".repeat(64),
	patch: { title: "List" },
};
const snapshot = {
	id: "list",
	workspaceId: "workspace",
	ownerId: "owner",
	title: "List",
	kind: "tasks" as const,
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink" as const,
};
test("normalizes title and field order, preserves optional patch identity and Unicode", () => {
	const first = parseApiListUpdate({
		...input,
		patch: { title: " List ", icon: null, completedDisplay: "hide" },
	});
	const second = parseApiListUpdate({
		patch: { completedDisplay: "hide", icon: null, title: "List" },
		expectedState: input.expectedState,
		workspaceId: "workspace",
	});
	expect(canonicalApiListUpdate("list", first)).toBe(
		canonicalApiListUpdate("list", second),
	);
	expect(canonicalApiListUpdate("other", first)).not.toBe(
		canonicalApiListUpdate("list", first),
	);
	expect(canonicalApiListUpdate("list", first)).toContain(
		'"operation":"list.update.v1"',
	);
	expect(
		parseApiListUpdate({ ...input, patch: { title: "عربية", icon: "🛒" } })
			.patch.icon,
	).toBe("🛒");
	expect(
		parseApiListUpdate({
			...input,
			patch: { title: "a".repeat(500), icon: "i".repeat(128) },
		}).patch.title,
	).toHaveLength(500);
	expect(canonicalApiListUpdate("list", input)).not.toBe(
		canonicalApiListUpdate(
			"list",
			parseApiListUpdate({ ...input, patch: { title: "List", icon: null } }),
		),
	);
});
test.each([
	null,
	[],
	{},
	{ ...input, extra: true },
	{ ...input, workspaceId: "" },
	{ ...input, workspaceId: "w".repeat(257) },
	{ ...input, expectedState: "A".repeat(64) },
	{ ...input, expectedState: "a".repeat(63) },
	...[
		{},
		{ title: " " },
		{ title: "a".repeat(501) },
		{ icon: "i".repeat(129) },
		{ icon: 1 },
		{ completedDisplay: "unknown" },
		{ folderId: "" },
		{ kind: "tasks" },
		{ sortKey: "a00" },
		{ ownerId: "owner" },
		{ title: undefined },
	].map((patch) => ({ ...input, patch })),
	JSON.parse(
		'{"workspaceId":"workspace","expectedState":"' +
			"a".repeat(64) +
			'","patch":{"__proto__":{}}}',
	),
	Object.assign(Object.create({}), input),
	{ ...input, patch: Object.assign(Object.create({ title: "Inherited" }), {}) },
	{ ...input, [Symbol("field")]: true },
])("strictly refuses invalid metadata input %j", (value) => {
	expect(() => parseApiListUpdate(value)).toThrow(PublicApiError);
});
test("rejects accessors and nonenumerable fields without evaluating getters", () => {
	let called = false;
	const patch = Object.defineProperty({}, "title", {
		enumerable: true,
		get() {
			called = true;
			return "List";
		},
	});
	expect(() => parseApiListUpdate({ ...input, patch })).toThrow();
	expect(called).toBe(false);
	expect(() =>
		parseApiListUpdate({
			...input,
			patch: Object.defineProperty({}, "title", { value: "List" }),
		}),
	).toThrow();
});
test.each([
	"title",
	"icon",
	"workspaceId",
])("rejects NUL and unpaired surrogates in %s", (field) => {
	for (const value of ["bad\0text", "bad\uD800", "bad\uDC00"]) {
		const body =
			field === "workspaceId"
				? { ...input, workspaceId: value }
				: { ...input, patch: { [field]: value } };
		expect(() => parseApiListUpdate(body)).toThrow();
	}
});
test("versioned state covers every ApiList scalar and permits same-state ABA", () => {
	expect(canonicalApiListSnapshot(snapshot)).toContain('"version":1');
	expect(listStateToken({ ...snapshot })).toBe(listStateToken(snapshot));
	for (const [key, value] of Object.entries({
		id: "other",
		workspaceId: "other",
		ownerId: "other",
		title: "Changed",
		kind: "shopping",
		icon: "star",
		folderId: "folder",
		sortKey: "a1",
		completedDisplay: "hide",
	}))
		expect(listStateToken({ ...snapshot, [key]: value })).not.toBe(
			listStateToken(snapshot),
		);
	expect(
		apiListObservationSchema.parse({
			snapshot,
			stateToken: listStateToken(snapshot),
		}).snapshot,
	).toEqual(snapshot);
	expect(
		apiListUpdateAckSchema.parse({ kind: "list-update-ack", snapshot })
			.snapshot,
	).toEqual(snapshot);
	for (const bad of [
		{ kind: "list-create-ack", snapshot },
		{ kind: "list-update-ack", snapshot: { ...snapshot, extra: true } },
		snapshot,
	])
		expect(apiListUpdateAckSchema.safeParse(bad).success).toBe(false);
});

test("placement preserves opaque valid keys and old request bytes", () => {
	expect(canonicalApiListUpdate("list", input)).toBe(
		`{"operation":"list.update.v1","listId":"list","workspaceId":"workspace","expectedState":"${"a".repeat(64)}","patch":{"title":"List"}}`,
	);
	for (const sortKey of [
		"a0",
		"a1",
		"Zz",
		"a0abc123",
		`a0${"1".repeat(254)}`,
	]) {
		expect(
			parseApiListUpdate({ ...input, patch: { folderId: "folder", sortKey } })
				.patch,
		).toEqual({ folderId: "folder", sortKey });
	}
	expect(
		parseApiListUpdate({ ...input, patch: { folderId: null } }).patch,
	).toEqual({ folderId: null });
	expect(
		canonicalApiListUpdate("list", { ...input, patch: { folderId: null } }),
	).not.toBe(canonicalApiListUpdate("list", input));
	expect(
		canonicalApiListUpdate("list", {
			...input,
			patch: { sortKey: "a1", folderId: null },
		}),
	).toBe(
		canonicalApiListUpdate("list", {
			...input,
			patch: { folderId: null, sortKey: "a1" },
		}),
	);
});
test.each([
	"",
	"a",
	"0a",
	"b0",
	"a00",
	"a0 ",
	" a0",
	"a0!",
	"a0\n",
	"a0é",
	"a0\0",
	`a0${"1".repeat(255)}`,
	`A${"0".repeat(26)}`,
])("invalid placement key %j fails closed", (sortKey) => {
	expect(() => parseApiListUpdate({ ...input, patch: { sortKey } })).toThrow(
		PublicApiError,
	);
});
