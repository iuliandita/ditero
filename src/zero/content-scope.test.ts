import type { Transaction } from "@rocicorp/zero";
import { expect, test, vi } from "vitest";
import { mutators } from "./mutators.ts";
import type { Schema } from "./schema.gen.ts";

function transaction(...reads: unknown[]) {
	const insert = vi.fn();
	const update = vi.fn();
	const run = vi.fn();
	for (const row of reads) run.mockResolvedValueOnce(row);
	const tx = {
		location: "client",
		run,
		mutate: {
			list: { insert, update },
			task: { insert },
			focusSession: { insert },
		},
	} as unknown as Transaction<Schema>;
	return { tx, insert, update };
}

const ctx = { id: "alice" };
const member = [{ role: "member" }];
const content = {
	kind: "list" as const,
	listKind: "tasks" as const,
	tasks: [{ title: "Task" }],
};
const args = {
	workspaceId: "own",
	listId: "new",
	sortKey: "a0",
	name: "List",
	content,
};

test("optimistic list expansion refuses an existing id before inserting tasks", async () => {
	const { tx, insert } = transaction(member, member, { id: "new" });
	await expect(
		mutators.template.instantiateContent.fn({ tx, ctx, args }),
	).rejects.toThrow(/creation conflicts/);
	expect(insert).not.toHaveBeenCalled();
});

test("list expansion verifies the row that an insert actually retained", async () => {
	const { tx, insert } = transaction(member, member, undefined, {
		id: "new",
		workspaceId: "other",
		ownerId: "bob",
	});
	await expect(
		mutators.template.instantiateContent.fn({ tx, ctx, args }),
	).rejects.toThrow(/creation conflicts/);
	expect(insert).toHaveBeenCalledOnce();
});

test.each([
	"create",
	"inline",
	"update",
])("optimistic %s requires a local folder", async (kind) => {
	const reads = [{ id: "folder", workspaceId: "other" }];
	const { tx, insert, update } = transaction(
		...(kind === "update" ? [{ workspaceId: "own" }, member] : [member]),
		...(kind === "inline" ? [member] : []),
		...reads,
	);
	const result =
		kind === "create"
			? mutators.list.create.fn({
					tx,
					ctx,
					args: {
						id: "new",
						workspaceId: "own",
						title: "List",
						kind: "tasks",
						sortKey: "a0",
						folderId: "folder",
					},
				})
			: kind === "inline"
				? mutators.template.instantiateContent.fn({
						tx,
						ctx,
						args: { ...args, folderId: "folder" },
					})
				: mutators.list.update.fn({
						tx,
						ctx,
						args: { id: "list", folderId: "folder" },
					});
	await expect(result).rejects.toThrow(/folder not in list workspace/);
	expect(insert).not.toHaveBeenCalled();
	expect(update).not.toHaveBeenCalled();
});

test("optimistic task expansion verifies the retained root before inserting children", async () => {
	const { tx, insert } = transaction(
		{ workspaceId: "own" },
		member,
		{
			workspaceId: "own",
			content: {
				kind: "task",
				task: { title: "Root", subtasks: [{ title: "Child" }] },
			},
		},
		member,
		undefined,
		{ listId: "other", parentId: null },
	);
	await expect(
		mutators.template.instantiateTask.fn({
			tx,
			ctx,
			args: {
				templateId: "template",
				taskId: "new",
				listId: "list",
				sortKey: "a0",
			},
		}),
	).rejects.toThrow(/creation conflicts/);
	expect(insert).toHaveBeenCalledOnce();
});

test("optimistic focus task references require workspace write access", async () => {
	const { tx, insert } = transaction({ list: { workspaceId: "other" } }, [
		{ role: "viewer" },
	]);
	await expect(
		mutators.focus.logSession.fn({
			tx,
			ctx,
			args: {
				taskId: "task",
				kind: "work",
				startedAt: 0,
				endedAt: 1000,
				durationSec: 1,
			},
		}),
	).rejects.toThrow(/access denied/);
	expect(insert).not.toHaveBeenCalled();
});
