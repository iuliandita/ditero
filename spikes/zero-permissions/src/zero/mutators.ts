// Write-permission custom mutators. Authorization is arbitrary code that runs
// server-side (and client-side for optimism). Role is looked up from the
// membership table via tx.run, then gates the write.
import { defineMutator, defineMutators } from "@rocicorp/zero";
import { z } from "zod";
import { zql } from "./schema.gen.ts";

const WRITE_ROLES = new Set(["owner", "admin", "member"]); // may edit content
const ADMIN_ROLES = new Set(["owner", "admin"]); // may manage membership

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
  membership: {
    setRole: defineMutator(
      z.object({
        workspaceId: z.string(),
        userId: z.string(),
        role: z.enum(["owner", "admin", "member", "viewer"]),
      }),
      async ({ tx, ctx, args }: any) => {
        const callerRole = await roleInWorkspace(tx, ctx.id, args.workspaceId);
        if (!callerRole || !ADMIN_ROLES.has(callerRole)) {
          throw new Error("access denied: need admin+");
        }
        const target = await tx.run(
          zql.membership
            .where("workspaceId", args.workspaceId)
            .where("userId", args.userId)
            .one(),
        );
        if (!target) throw new Error("membership not found");
        await tx.mutate.membership.update({ id: target.id, role: args.role });
      },
    ),
  },
});
