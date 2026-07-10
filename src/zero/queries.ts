// Read-permission queries (synced queries).
// Enforcement runs server-side in the /api/zero/query endpoint, which authenticates
// the JWT and passes ctx = { id }. zero-cache only ever syncs what these return.
import { defineQueries, defineQuery } from "@rocicorp/zero";
import { zql } from "./schema.gen.ts";

export type AuthCtx = { id: string };

const listVisible =
	(ctx: AuthCtx) =>
	({ exists }: any) =>
		exists("workspace", (w: any) =>
			w.where(({ exists: ex }: any) =>
				ex("memberships", (m: any) => m.where("userId", ctx.id)),
			),
		);

export const queries = defineQueries({
	workspaces: {
		// A workspace is visible when the user has a membership in it.
		mine: defineQuery(({ ctx }: { ctx: AuthCtx }) =>
			zql.workspace.where(({ exists }: any) =>
				exists("memberships", (m: any) => m.where("userId", ctx.id)),
			),
		),
	},
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
