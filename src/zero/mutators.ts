// Write-permission custom mutators. Authorization is arbitrary code that runs
// server-side (and client-side for optimism). Role is looked up from the
// membership table via tx.run, then gates the write.
//
// Mutators run on both client (optimistic) and server (authoritative). Zero
// client cannot see Postgres column defaults, so every insert sets the
// client-invisible defaults (kind, completedDisplay, priority, dueAllDay, done,
// label.color) explicitly. FK cascades (task_label on task/label delete) also
// only apply server-side; subtask deletion has no DB cascade (parent_id is
// `no action`) and is done in-mutator.
import {
	defineMutator,
	defineMutators,
	type ReadonlyJSONValue,
	type Transaction,
} from "@rocicorp/zero";
import { z } from "zod";
import type { ListKind } from "../domain/icon-map.ts";
import { keyBetween } from "../domain/sort-key.ts";
import {
	type InstantiatedTask,
	instantiate,
	templateContentSchema,
} from "../domain/template.ts";
import { type List, type Schema, zql } from "./schema.gen.ts";

const WRITE_ROLES = new Set(["owner", "admin", "member"]); // may edit content
const ADMIN_ROLES = new Set(["owner", "admin"]);

const DENIED = "access denied: need member+";

async function roleInWorkspace(
	tx: Transaction<Schema>,
	userId: string,
	workspaceId: string,
): Promise<string | null | undefined> {
	const rows = await tx.run(
		zql.membership.where("userId", userId).where("workspaceId", workspaceId),
	);
	return rows[0]?.role;
}

// Shared content-write gate. Callers resolve the workspace themselves (direct
// arg, or via list / task->list) and pass it in.
async function requireWrite(
	tx: Transaction<Schema>,
	userId: string,
	workspaceId: string,
): Promise<void> {
	const role = await roleInWorkspace(tx, userId, workspaceId);
	if (!role || !WRITE_ROLES.has(role)) throw new Error(DENIED);
}

// `satisfies` ties the tuple to ListKind so a typo or removed kind fails to
// compile (twin of LIST_KINDS in domain/template.ts).
const LIST_KINDS = [
	"tasks",
	"shopping",
	"checklist",
	"project",
	"habits",
] as const satisfies readonly ListKind[];
const listKind = z.enum(LIST_KINDS);
const completedDisplay = z.enum(["sink", "keep", "hide"]);
const templateKind = z.enum(["list", "task"]);

// Deterministic id generator seeded from a client-supplied id, so an
// instantiate mutator produces identical ids on the optimistic client and the
// authoritative server. First id is the seed itself (the list/root-task id the
// client passed); children are `${seed}-N`.
function seededIds(seed: string): () => string {
	let n = 0;
	return () => {
		const id = n === 0 ? seed : `${seed}-${n}`;
		n++;
		return id;
	};
}

// Insert one instantiated task, applying the client-invisible column defaults
// (done, dueAllDay, priority) exactly like task.create does.
async function insertInstantiatedTask(
	tx: Transaction<Schema>,
	t: InstantiatedTask,
): Promise<void> {
	await tx.mutate.task.insert({
		id: t.id,
		listId: t.listId,
		title: t.title,
		sortKey: t.sortKey,
		done: false,
		dueAllDay: false,
		priority: t.priority ?? 0,
		...(t.parentId !== undefined ? { parentId: t.parentId } : {}),
		...(t.notes !== undefined ? { notes: t.notes } : {}),
		...(t.quantity !== undefined ? { quantity: t.quantity } : {}),
		...(t.unit !== undefined ? { unit: t.unit } : {}),
		...(t.category !== undefined ? { category: t.category } : {}),
	});
}

export const mutators = defineMutators({
	task: {
		create: defineMutator(
			z.object({
				id: z.string(),
				listId: z.string(),
				title: z.string(),
				sortKey: z.string(),
				notes: z.string().optional(),
				dueAt: z.number().nullable().optional(),
				dueAllDay: z.boolean().optional(),
				priority: z.number().optional(),
				parentId: z.string().nullable().optional(),
				quantity: z.string().optional(),
				unit: z.string().optional(),
				category: z.string().optional(),
			}),
			async ({ tx, ctx, args }) => {
				const list = await tx.run(zql.list.where("id", args.listId).one());
				if (!list) throw new Error("list not found");
				await requireWrite(tx, ctx.id, list.workspaceId);
				if (args.parentId != null) {
					const parent = await tx.run(
						zql.task.where("id", args.parentId).one(),
					);
					if (!parent) throw new Error("parent task not found");
					if (parent.parentId != null)
						throw new Error("subtasks are one level");
					if (parent.listId !== args.listId)
						throw new Error("parent in different list");
				}
				await tx.mutate.task.insert({
					id: args.id,
					listId: args.listId,
					title: args.title,
					sortKey: args.sortKey,
					done: false,
					dueAllDay: args.dueAllDay ?? false,
					priority: args.priority ?? 0,
					...(args.notes !== undefined ? { notes: args.notes } : {}),
					...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}),
					...(args.parentId != null ? { parentId: args.parentId } : {}),
					...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
					...(args.unit !== undefined ? { unit: args.unit } : {}),
					...(args.category !== undefined ? { category: args.category } : {}),
				});
			},
		),
		update: defineMutator(
			z.object({
				id: z.string(),
				title: z.string().optional(),
				done: z.boolean().optional(),
				notes: z.string().nullable().optional(),
				dueAt: z.number().nullable().optional(),
				dueAllDay: z.boolean().optional(),
				priority: z.number().optional(),
				quantity: z.string().nullable().optional(),
				unit: z.string().nullable().optional(),
				category: z.string().nullable().optional(),
				sortKey: z.string().optional(),
			}),
			async ({ tx, ctx, args }) => {
				const task = await tx.run(
					zql.task.where("id", args.id).related("list").one(),
				);
				if (!task) throw new Error("task not found");
				const list = task.list as List;
				await requireWrite(tx, ctx.id, list.workspaceId);
				// done and completedAt are one invariant, kept here in one place.
				const completed =
					args.done === undefined
						? {}
						: { completedAt: args.done ? Date.now() : null };
				await tx.mutate.task.update({
					id: args.id,
					...(args.title !== undefined ? { title: args.title } : {}),
					...(args.done !== undefined ? { done: args.done } : {}),
					...completed,
					...(args.notes !== undefined ? { notes: args.notes } : {}),
					...(args.dueAt !== undefined ? { dueAt: args.dueAt } : {}),
					...(args.dueAllDay !== undefined
						? { dueAllDay: args.dueAllDay }
						: {}),
					...(args.priority !== undefined ? { priority: args.priority } : {}),
					...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
					...(args.unit !== undefined ? { unit: args.unit } : {}),
					...(args.category !== undefined ? { category: args.category } : {}),
					...(args.sortKey !== undefined ? { sortKey: args.sortKey } : {}),
				});
			},
		),
		move: defineMutator(
			z.object({ id: z.string(), listId: z.string(), sortKey: z.string() }),
			async ({ tx, ctx, args }) => {
				const target = await tx.run(zql.list.where("id", args.listId).one());
				if (!target) throw new Error("list not found");
				await requireWrite(tx, ctx.id, target.workspaceId);
				const task = await tx.run(zql.task.where("id", args.id).one());
				if (!task) throw new Error("task not found");
				if (task.listId !== args.listId) {
					// A subtask must stay in its parent's list; only parents relocate,
					// and their children cascade to the target list (same-list invariant
					// that task.create enforces).
					if (task.parentId != null)
						throw new Error("subtask must stay in its parent's list");
					const children = await tx.run(zql.task.where("parentId", args.id));
					for (const child of children) {
						await tx.mutate.task.update({ id: child.id, listId: args.listId });
					}
				}
				await tx.mutate.task.update({
					id: args.id,
					listId: args.listId,
					sortKey: args.sortKey,
				});
			},
		),
		delete: defineMutator(
			z.object({ id: z.string() }),
			async ({ tx, ctx, args }) => {
				const task = await tx.run(
					zql.task.where("id", args.id).related("list").one(),
				);
				if (!task) throw new Error("task not found");
				const list = task.list as List;
				await requireWrite(tx, ctx.id, list.workspaceId);
				// parent_id FK is `no action`: delete children explicitly first.
				const children = await tx.run(zql.task.where("parentId", args.id));
				for (const child of children) {
					await tx.mutate.task.delete({ id: child.id });
				}
				await tx.mutate.task.delete({ id: args.id });
			},
		),
	},
	list: {
		create: defineMutator(
			z.object({
				id: z.string(),
				workspaceId: z.string(),
				title: z.string(),
				kind: listKind,
				sortKey: z.string(),
				folderId: z.string().optional(),
				icon: z.string().optional(),
			}),
			async ({ tx, ctx, args }) => {
				await requireWrite(tx, ctx.id, args.workspaceId);
				await tx.mutate.list.insert({
					id: args.id,
					workspaceId: args.workspaceId,
					ownerId: ctx.id,
					title: args.title,
					kind: args.kind,
					sortKey: args.sortKey,
					completedDisplay: "sink",
					...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
					...(args.icon !== undefined ? { icon: args.icon } : {}),
				});
			},
		),
		update: defineMutator(
			z.object({
				id: z.string(),
				title: z.string().optional(),
				icon: z.string().nullable().optional(),
				folderId: z.string().nullable().optional(),
				completedDisplay: completedDisplay.optional(),
				sortKey: z.string().optional(),
			}),
			async ({ tx, ctx, args }) => {
				const list = await tx.run(zql.list.where("id", args.id).one());
				if (!list) throw new Error("list not found");
				await requireWrite(tx, ctx.id, list.workspaceId);
				await tx.mutate.list.update({
					id: args.id,
					...(args.title !== undefined ? { title: args.title } : {}),
					...(args.icon !== undefined ? { icon: args.icon } : {}),
					...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
					...(args.completedDisplay !== undefined
						? { completedDisplay: args.completedDisplay }
						: {}),
					...(args.sortKey !== undefined ? { sortKey: args.sortKey } : {}),
				});
			},
		),
		delete: defineMutator(
			z.object({ id: z.string() }),
			async ({ tx, ctx, args }) => {
				const list = await tx.run(zql.list.where("id", args.id).one());
				if (!list) throw new Error("list not found");
				const role = await roleInWorkspace(tx, ctx.id, list.workspaceId);
				// member+ may delete their own list; deleting others' needs admin+.
				const canDelete =
					(role != null && ADMIN_ROLES.has(role)) ||
					(list.ownerId === ctx.id && role != null && WRITE_ROLES.has(role));
				if (!canDelete)
					throw new Error("access denied: need admin+ or list owner");
				// list_id FK is `no action`: delete tasks first (children before
				// parents), task_label cascades on task delete.
				const tasks = await tx.run(zql.task.where("listId", args.id));
				for (const t of tasks) {
					if (t.parentId != null) await tx.mutate.task.delete({ id: t.id });
				}
				for (const t of tasks) {
					if (t.parentId == null) await tx.mutate.task.delete({ id: t.id });
				}
				await tx.mutate.list.delete({ id: args.id });
			},
		),
	},
	folder: {
		create: defineMutator(
			z.object({
				id: z.string(),
				workspaceId: z.string(),
				name: z.string(),
				sortKey: z.string(),
			}),
			async ({ tx, ctx, args }) => {
				await requireWrite(tx, ctx.id, args.workspaceId);
				await tx.mutate.folder.insert({
					id: args.id,
					workspaceId: args.workspaceId,
					name: args.name,
					sortKey: args.sortKey,
				});
			},
		),
		update: defineMutator(
			z.object({
				id: z.string(),
				name: z.string().optional(),
				sortKey: z.string().optional(),
			}),
			async ({ tx, ctx, args }) => {
				const folder = await tx.run(zql.folder.where("id", args.id).one());
				if (!folder) throw new Error("folder not found");
				await requireWrite(tx, ctx.id, folder.workspaceId);
				await tx.mutate.folder.update({
					id: args.id,
					...(args.name !== undefined ? { name: args.name } : {}),
					...(args.sortKey !== undefined ? { sortKey: args.sortKey } : {}),
				});
			},
		),
		delete: defineMutator(
			z.object({ id: z.string() }),
			async ({ tx, ctx, args }) => {
				const folder = await tx.run(zql.folder.where("id", args.id).one());
				if (!folder) throw new Error("folder not found");
				await requireWrite(tx, ctx.id, folder.workspaceId);
				// folder_id FK is `no action`; refuse to orphan lists.
				const lists = await tx.run(zql.list.where("folderId", args.id));
				if (lists.length > 0) throw new Error("folder not empty");
				await tx.mutate.folder.delete({ id: args.id });
			},
		),
	},
	label: {
		create: defineMutator(
			z.object({
				id: z.string(),
				workspaceId: z.string(),
				name: z.string(),
				color: z.string().optional(),
			}),
			async ({ tx, ctx, args }) => {
				await requireWrite(tx, ctx.id, args.workspaceId);
				const existing = await tx.run(
					zql.label
						.where("workspaceId", args.workspaceId)
						.where("name", args.name),
				);
				if (existing.length > 0) throw new Error("label name already exists");
				await tx.mutate.label.insert({
					id: args.id,
					workspaceId: args.workspaceId,
					name: args.name,
					color: args.color ?? "gray",
				});
			},
		),
		update: defineMutator(
			z.object({
				id: z.string(),
				name: z.string().optional(),
				color: z.string().optional(),
			}),
			async ({ tx, ctx, args }) => {
				const label = await tx.run(zql.label.where("id", args.id).one());
				if (!label) throw new Error("label not found");
				await requireWrite(tx, ctx.id, label.workspaceId);
				if (args.name !== undefined && args.name !== label.name) {
					const existing = await tx.run(
						zql.label
							.where("workspaceId", label.workspaceId)
							.where("name", args.name),
					);
					if (existing.length > 0) throw new Error("label name already exists");
				}
				await tx.mutate.label.update({
					id: args.id,
					...(args.name !== undefined ? { name: args.name } : {}),
					...(args.color !== undefined ? { color: args.color } : {}),
				});
			},
		),
		delete: defineMutator(
			z.object({ id: z.string() }),
			async ({ tx, ctx, args }) => {
				const label = await tx.run(zql.label.where("id", args.id).one());
				if (!label) throw new Error("label not found");
				await requireWrite(tx, ctx.id, label.workspaceId);
				// task_label rows clear via server FK cascade only; no client-side
				// cleanup here (optimistic clients drop them on the next sync).
				await tx.mutate.label.delete({ id: args.id });
			},
		),
	},
	taskLabel: {
		// Diff current vs desired in one mutator to stay atomic. Row id is the
		// deterministic `taskId:labelId` pair so client and server converge.
		set: defineMutator(
			z.object({ taskId: z.string(), labelIds: z.array(z.string()) }),
			async ({ tx, ctx, args }) => {
				const task = await tx.run(
					zql.task.where("id", args.taskId).related("list").one(),
				);
				if (!task) throw new Error("task not found");
				const list = task.list as List;
				await requireWrite(tx, ctx.id, list.workspaceId);
				const desired = new Set(args.labelIds);
				// Labels are workspace-scoped; reject attaching another workspace's
				// label (it would otherwise sync via taskLabels.mine).
				for (const labelId of desired) {
					const label = await tx.run(zql.label.where("id", labelId).one());
					if (!label || label.workspaceId !== list.workspaceId)
						throw new Error("label not in task workspace");
				}
				const current = await tx.run(
					zql.taskLabel.where("taskId", args.taskId),
				);
				const have = new Map(current.map((r) => [r.labelId, r.id]));
				for (const [labelId, id] of have) {
					if (!desired.has(labelId)) await tx.mutate.taskLabel.delete({ id });
				}
				for (const labelId of desired) {
					if (!have.has(labelId)) {
						await tx.mutate.taskLabel.insert({
							id: `${args.taskId}:${labelId}`,
							taskId: args.taskId,
							labelId,
						});
					}
				}
			},
		),
	},
	template: {
		// Create a reusable template from a client-built content snapshot. Content
		// is validated against the domain schema so malformed jsonb never lands.
		save: defineMutator(
			z.object({
				id: z.string(),
				workspaceId: z.string(),
				name: z.string(),
				kind: templateKind,
				icon: z.string().optional(),
				content: templateContentSchema,
			}),
			async ({ tx, ctx, args }) => {
				await requireWrite(tx, ctx.id, args.workspaceId);
				if (args.kind !== args.content.kind)
					throw new Error("template kind does not match content");
				await tx.mutate.template.insert({
					id: args.id,
					workspaceId: args.workspaceId,
					kind: args.kind,
					name: args.name,
					content: args.content as ReadonlyJSONValue,
					createdBy: ctx.id,
					...(args.icon !== undefined ? { icon: args.icon } : {}),
				});
			},
		),
		delete: defineMutator(
			z.object({ id: z.string() }),
			async ({ tx, ctx, args }) => {
				const template = await tx.run(zql.template.where("id", args.id).one());
				if (!template) throw new Error("template not found");
				const role = await roleInWorkspace(tx, ctx.id, template.workspaceId);
				// Creator (member+) may delete their own; deleting others' needs admin+.
				const canDelete =
					(role != null && ADMIN_ROLES.has(role)) ||
					(template.createdBy === ctx.id &&
						role != null &&
						WRITE_ROLES.has(role));
				if (!canDelete)
					throw new Error("access denied: need admin+ or template creator");
				await tx.mutate.template.delete({ id: args.id });
			},
		),
		// Expand a list template into a fresh list + its tasks in the target
		// workspace. The client supplies the new list id + sortKey (like
		// list.create); child ids derive deterministically from the list id.
		instantiateList: defineMutator(
			z.object({
				templateId: z.string(),
				workspaceId: z.string(),
				listId: z.string(),
				sortKey: z.string(),
			}),
			async ({ tx, ctx, args }) => {
				await requireWrite(tx, ctx.id, args.workspaceId);
				const template = await tx.run(
					zql.template.where("id", args.templateId).one(),
				);
				if (!template) throw new Error("template not found");
				// Only usable from a workspace the caller can see the template in.
				const srcRole = await roleInWorkspace(tx, ctx.id, template.workspaceId);
				if (!srcRole) throw new Error(DENIED);
				const content = templateContentSchema.parse(template.content);
				if (content.kind !== "list") throw new Error("not a list template");
				const { list, tasks } = instantiate(
					content,
					seededIds(args.listId),
					keyBetween,
					{ sortKey: args.sortKey, title: template.name },
				);
				if (!list) throw new Error("list template produced no list");
				await tx.mutate.list.insert({
					id: list.id,
					workspaceId: args.workspaceId,
					ownerId: ctx.id,
					title: list.title,
					kind: list.kind,
					sortKey: list.sortKey,
					completedDisplay: "sink",
					...(list.icon !== undefined ? { icon: list.icon } : {}),
				});
				for (const t of tasks) await insertInstantiatedTask(tx, t);
			},
		),
		// Expand a task template into the target list. The client supplies the new
		// root task id + sortKey; subtask ids derive from it.
		instantiateTask: defineMutator(
			z.object({
				templateId: z.string(),
				taskId: z.string(),
				listId: z.string(),
				sortKey: z.string(),
			}),
			async ({ tx, ctx, args }) => {
				const targetList = await tx.run(
					zql.list.where("id", args.listId).one(),
				);
				if (!targetList) throw new Error("list not found");
				await requireWrite(tx, ctx.id, targetList.workspaceId);
				const template = await tx.run(
					zql.template.where("id", args.templateId).one(),
				);
				if (!template) throw new Error("template not found");
				const srcRole = await roleInWorkspace(tx, ctx.id, template.workspaceId);
				if (!srcRole) throw new Error(DENIED);
				const content = templateContentSchema.parse(template.content);
				if (content.kind !== "task") throw new Error("not a task template");
				const { tasks } = instantiate(
					content,
					seededIds(args.taskId),
					keyBetween,
					{ sortKey: args.sortKey, listId: args.listId },
				);
				for (const t of tasks) await insertInstantiatedTask(tx, t);
			},
		),
	},
});
