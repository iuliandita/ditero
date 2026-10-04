import { describe, expect, test } from "vitest";
import {
	canonicalApiTaskRelationshipSnapshot,
	canonicalApiTaskRelationships,
	parseApiTaskRelationships,
	taskRelationshipsAck,
} from "./public-api-task-relationships.ts";

const body = {
	workspaceId: "w",
	listId: "l",
	expectedState: "a".repeat(64),
	assigneeIds: ["b", "a"],
	labelIds: ["z", "y"],
};
test("full desired sets canonicalize ordering and bind operation, task, scope and token", () => {
	expect(parseApiTaskRelationships(body).assigneeIds).toEqual(["a", "b"]);
	expect(canonicalApiTaskRelationships("t", body)).toBe(
		canonicalApiTaskRelationships("t", {
			...body,
			assigneeIds: ["a", "b"],
			labelIds: ["y", "z"],
		}),
	);
	for (const value of [
		{ ...body, workspaceId: "other" },
		{ ...body, listId: "other" },
		{ ...body, expectedState: "b".repeat(64) },
		{ ...body, assigneeIds: [] },
		{ ...body, labelIds: [] },
	])
		expect(canonicalApiTaskRelationships("t", value)).not.toBe(
			canonicalApiTaskRelationships("t", body),
		);
	expect(canonicalApiTaskRelationships("other", body)).not.toBe(
		canonicalApiTaskRelationships("t", body),
	);
});
test("acknowledgment is derived from exact original target scope and both sets", () => {
	expect(taskRelationshipsAck("t", body)).toEqual({
		kind: "task-relationships-update-ack",
		snapshot: {
			version: 1,
			taskId: "t",
			workspaceId: "w",
			listId: "l",
			assigneeIds: ["a", "b"],
			labelIds: ["y", "z"],
		},
	});
	expect(
		canonicalApiTaskRelationshipSnapshot(
			taskRelationshipsAck("t", body).snapshot,
		),
	).toContain('"version":1');
	expect(
		parseApiTaskRelationships({ ...body, assigneeIds: [], labelIds: [] }),
	).toMatchObject({ assigneeIds: [], labelIds: [] });
});
describe("strict bounds", () => {
	test.each([
		null,
		[],
		{ ...body, extra: true },
		{ ...body, assigneeIds: undefined },
		{ ...body, labelIds: undefined },
		{ ...body, assigneeIds: ["a", "a"] },
		{ ...body, labelIds: ["y", "y"] },
		{ ...body, assigneeIds: Array.from({ length: 21 }, (_, i) => String(i)) },
		{ ...body, labelIds: Array.from({ length: 51 }, (_, i) => String(i)) },
		{ ...body, listId: "\0" },
		{ ...body, workspaceId: "\ud800" },
		{ ...body, assigneeIds: ["\ud800"] },
		{ ...body, expectedState: "A".repeat(64) },
	])("rejects unsupported fields or references %j", (value) =>
		expect(() => parseApiTaskRelationships(value)).toThrow());
	test("rejects accessors, symbols and non-data prototypes before evaluation", () => {
		let called = false;
		const value = { ...body };
		Object.defineProperty(value, "listId", {
			enumerable: true,
			get() {
				called = true;
				return "l";
			},
		});
		expect(() => parseApiTaskRelationships(value)).toThrow();
		expect(called).toBe(false);
		expect(() =>
			parseApiTaskRelationships({ ...body, [Symbol()]: true }),
		).toThrow();
		expect(() =>
			parseApiTaskRelationships(Object.assign(Object.create({}), body)),
		).toThrow();
	});
});
