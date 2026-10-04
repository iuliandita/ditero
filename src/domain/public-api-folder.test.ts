import { expect, test } from "vitest";
import { folderStateToken } from "../server/public-api/folder-observation.ts";
import { PublicApiError } from "./public-api.ts";
import {
	apiFolderCreateAckSchema,
	apiFolderDeleteAckSchema,
	apiFolderObservationSchema,
	apiFolderUpdateAckSchema,
	canonicalApiFolderCreate,
	canonicalApiFolderDelete,
	canonicalApiFolderUpdate,
	parseApiFolderCreate,
	parseApiFolderDelete,
	parseApiFolderUpdate,
} from "./public-api-folder.ts";

const snapshot = {
	id: "folder",
	workspaceId: "workspace",
	name: "Folder",
	sortKey: "a0",
};
const create = { workspaceId: "workspace", name: " Folder " };
const update = {
	workspaceId: "workspace",
	expectedState: "a".repeat(64),
	patch: { name: "Renamed" },
};
const remove = { workspaceId: "workspace", expectedState: "a".repeat(64) };
test("strict folder requests normalize names and canonicalize every operation/body/id", () => {
	expect(parseApiFolderCreate(create)).toEqual({ ...create, name: "Folder" });
	expect(canonicalApiFolderCreate(create)).toBe(
		canonicalApiFolderCreate({ ...create, name: "Folder" }),
	);
	expect(
		parseApiFolderUpdate({ ...update, patch: { name: " Renamed " } }),
	).toEqual(update);
	expect(parseApiFolderDelete(remove)).toEqual(remove);
	expect(canonicalApiFolderUpdate("folder", update)).not.toBe(
		canonicalApiFolderUpdate("other", update),
	);
	expect(canonicalApiFolderDelete("folder", remove)).not.toBe(
		canonicalApiFolderUpdate("folder", update),
	);
	for (const changed of [
		{ ...remove, workspaceId: "other" },
		{ ...remove, expectedState: "b".repeat(64) },
	])
		expect(canonicalApiFolderDelete("folder", changed)).not.toBe(
			canonicalApiFolderDelete("folder", remove),
		);
	expect(parseApiFolderCreate({ ...create, name: "عربية" }).name).toBe("عربية");
	expect(
		parseApiFolderCreate({ ...create, name: "n".repeat(500) }).name,
	).toHaveLength(500);
});
test.each([
	null,
	[],
	{},
	{ ...create, extra: true },
	{ ...create, name: " " },
	{ ...create, name: "n".repeat(501) },
	{ ...create, name: "bad\0name" },
	{ ...create, name: "bad\uD800" },
	{ ...create, workspaceId: "bad\0id" },
	Object.assign(Object.create({}), create),
	{ ...create, [Symbol("extra")]: true },
])("refuses invalid creation %j", (value) =>
	expect(() => parseApiFolderCreate(value)).toThrow(PublicApiError));
test.each([
	{ ...update, patch: {} },
	{ ...update, patch: { name: "Renamed", sortKey: "a1" } },
	{ ...update, patch: { name: undefined } },
	{ ...update, expectedState: "A".repeat(64) },
	{ ...update, ownerId: "actor" },
])("refuses invalid rename %j", (value) =>
	expect(() => parseApiFolderUpdate(value)).toThrow(PublicApiError));
test.each([
	{ ...remove, cascade: true },
	{ ...remove, expectedState: "a".repeat(63) },
	{ ...remove, workspaceId: "" },
])("refuses invalid empty-delete %j", (value) =>
	expect(() => parseApiFolderDelete(value)).toThrow(PublicApiError));
test("accessors are rejected without execution and nonenumerable fields are refused", () => {
	let called = false;
	const value = Object.defineProperty({ ...create }, "name", {
		enumerable: true,
		get() {
			called = true;
			return "Folder";
		},
	});
	expect(() => parseApiFolderCreate(value)).toThrow();
	expect(called).toBe(false);
	expect(() =>
		parseApiFolderCreate(
			Object.defineProperty({ ...create }, "name", {
				value: "Folder",
				enumerable: false,
			}),
		),
	).toThrow();
});
test("state covers all four folder fields, semantic ABA and strict immutable acknowledgement kinds", () => {
	for (const [field, value] of Object.entries({
		id: "other",
		workspaceId: "other",
		name: "Other",
		sortKey: "a1",
	}))
		expect(folderStateToken({ ...snapshot, [field]: value })).not.toBe(
			folderStateToken(snapshot),
		);
	expect(folderStateToken({ ...snapshot })).toBe(folderStateToken(snapshot));
	expect(
		apiFolderObservationSchema.parse({
			snapshot,
			stateToken: folderStateToken(snapshot),
		}).snapshot,
	).toEqual(snapshot);
	for (const [kind, schema] of [
		["folder-create-ack", apiFolderCreateAckSchema],
		["folder-update-ack", apiFolderUpdateAckSchema],
		["folder-delete-ack", apiFolderDeleteAckSchema],
	] as const) {
		expect(schema.parse({ kind, snapshot }).snapshot).toEqual(snapshot);
		expect(
			schema.safeParse({ kind, snapshot: { ...snapshot, extra: true } })
				.success,
		).toBe(false);
		expect(schema.safeParse({ kind: "other", snapshot }).success).toBe(false);
	}
});
