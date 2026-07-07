// Read-permission queries (synced queries).
// Enforcement runs server-side in the /api/zero/query endpoint, which authenticates
// the JWT and passes ctx = { id }. zero-cache only ever syncs what these return.
import { defineQueries, defineQuery } from "@rocicorp/zero";
import { zql } from "./schema.gen.ts";

export type AuthCtx = { id: string };

// A list is visible when the user is a member of its workspace AND
// (the list is workspace-visible OR the user owns it — covers private personal lists).
const listVisible =
  (ctx: AuthCtx) =>
  ({ and, or, cmp, exists }: any) =>
    and(
      exists("workspace", (w: any) =>
        w.where(({ exists: ex }: any) =>
          ex("memberships", (m: any) => m.where("userId", ctx.id)),
        ),
      ),
      or(cmp("visibility", "workspace"), cmp("ownerId", ctx.id)),
    );

export const queries = defineQueries({
  lists: {
    mine: defineQuery(({ ctx }: { ctx: AuthCtx }) =>
      zql.list.where(listVisible(ctx)),
    ),
  },
  tasks: {
    mine: defineQuery(({ ctx }: { ctx: AuthCtx }) =>
      zql.task.where(({ exists }: any) =>
        exists("list", (l: any) => l.where(listVisible(ctx))),
      ),
    ),
  },
});
