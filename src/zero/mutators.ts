// Write-permission custom mutators. Authorization is arbitrary code that runs
// server-side (and client-side for optimism). Role is looked up from the
// membership table via tx.run, then gates the write.
import { defineMutator, defineMutators } from "@rocicorp/zero";
import { z } from "zod";
import { zql } from "./schema.gen.ts";

const WRITE_ROLES = new Set(["owner", "admin", "member"]); // may edit content

async function roleInWorkspace(
	tx: any,
	userId: string,
	workspaceId: string,
): Promise<string | undefined> {
	const rows = await tx.run(
		zql.membership.where("userId", userId).where("workspaceId", workspaceId),
	);
	return rows[0]?.role;
}

export const mutators = defineMutators({
	task: {
		create: defineMutator(
			z.object({ id: z.string(), listId: z.string(), title: z.string() }),
			async ({ tx, ctx, args }: any) => {
				const list = await tx.run(zql.list.where("id", args.listId).one());
				if (!list) throw new Error("list not found");
				const role = await roleInWorkspace(tx, ctx.id, list.workspaceId);
				if (!role || !WRITE_ROLES.has(role)) {
					throw new Error("access denied: need member+");
				}
				// DB-side defaults are not applied by the Zero client — set done explicitly.
				await tx.mutate.task.insert({
					id: args.id,
					listId: args.listId,
					title: args.title,
					done: false,
				});
			},
		),
		update: defineMutator(
			z.object({
				id: z.string(),
				title: z.string().optional(),
				done: z.boolean().optional(),
			}),
			async ({ tx, ctx, args }: any) => {
				const task = await tx.run(
					zql.task.where("id", args.id).related("list").one(),
				);
				if (!task) throw new Error("task not found");
				const role = await roleInWorkspace(tx, ctx.id, task.list.workspaceId);
				if (!role || !WRITE_ROLES.has(role)) {
					throw new Error("access denied: need member+");
				}
				await tx.mutate.task.update({
					id: args.id,
					...(args.title !== undefined ? { title: args.title } : {}),
					...(args.done !== undefined ? { done: args.done } : {}),
				});
			},
		),
	},
	list: {
		create: defineMutator(
			z.object({
				id: z.string(),
				workspaceId: z.string(),
				title: z.string(),
			}),
			async ({ tx, ctx, args }: any) => {
				const role = await roleInWorkspace(tx, ctx.id, args.workspaceId);
				if (!role || !WRITE_ROLES.has(role)) {
					throw new Error("access denied: need member+");
				}
				await tx.mutate.list.insert({
					id: args.id,
					workspaceId: args.workspaceId,
					ownerId: ctx.id,
					title: args.title,
				});
			},
		),
	},
});
