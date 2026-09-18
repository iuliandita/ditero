import { expect, test } from "vitest";
import { digestImportTarget, importTargetProjection } from "./import-target.ts";

const task = {
	id: "task",
	list_id: "list",
	title: "Task",
	done: false,
	notes: null,
	due_at: new Date("2026-01-01T12:00:00.000Z"),
	due_all_day: false,
	priority: 0,
	completed_at: null,
	sort_key: "a0",
	parent_id: null,
	quantity: null,
	unit: null,
	category: null,
	rrule: null,
	recurrence_relative: false,
	reminder_time: null,
	repeat_every_min: null,
	max_repeats: null,
	fallback_user_id: null,
	urgent: false,
};
const checkpoint = () => {};

test("target timestamps are ISO values and changes alter the fingerprint", async () => {
	expect(importTargetProjection("tasks", task)).toMatchObject({
		dueAt: "2026-01-01T12:00:00.000Z",
		completedAt: null,
		listId: "list",
	});
	const before = await digestImportTarget("tasks", task, checkpoint);
	for (const change of [
		{ due_at: new Date("2026-01-02T12:00:00.000Z") },
		{ completed_at: new Date("2026-01-01T12:00:00.000Z") },
		{ list_id: "moved" },
		{ title: "Edited" },
	]) {
		expect(
			await digestImportTarget("tasks", { ...task, ...change }, checkpoint),
		).not.toBe(before);
	}
});

test("unknown database fields cannot affect or leak into target projections", async () => {
	const row = {
		id: "folder",
		workspace_id: "workspace",
		name: "Folder",
		sort_key: "a0",
	};
	const extended = { ...row, internal_field: "excluded" };
	expect(importTargetProjection("folders", extended)).toEqual({
		id: "folder",
		workspaceId: "workspace",
		name: "Folder",
		sortKey: "a0",
	});
	expect(await digestImportTarget("folders", extended, checkpoint)).toBe(
		await digestImportTarget("folders", row, checkpoint),
	);
});

test("missing fields and invalid timestamps fail instead of hashing incomplete state", () => {
	const { title: _title, ...incomplete } = task;
	expect(() => importTargetProjection("tasks", incomplete)).toThrow();
	for (const due_at of [new Date("invalid"), "2026-01-01", undefined]) {
		expect(() =>
			importTargetProjection("tasks", { ...task, due_at }),
		).toThrow();
	}
});
