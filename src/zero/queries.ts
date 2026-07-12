// Read-permission queries (synced queries).
// Enforcement runs server-side in the /api/zero/query endpoint, which authenticates
// the JWT and passes ctx = { id }. zero-cache only ever syncs what these return.
import {
	defineQueries,
	defineQuery,
	type ExpressionBuilder,
} from "@rocicorp/zero";
import { type Schema, zql } from "./schema.gen.ts";

export type AuthCtx = { id: string };

declare module "@rocicorp/zero" {
	interface DefaultTypes {
		context: AuthCtx;
	}
}

const listVisible =
	(ctx: AuthCtx) =>
	({ exists }: ExpressionBuilder<"list", Schema>) =>
		exists("workspace", (w) =>
			w.where(({ exists: ex }) =>
				ex("memberships", (m) => m.where("userId", ctx.id)),
			),
		);

export const queries = defineQueries({
	workspaces: {
		// A workspace is visible when the user has a membership in it.
		mine: defineQuery(({ ctx }) =>
			zql.workspace.where(({ exists }) =>
				exists("memberships", (m) => m.where("userId", ctx.id)),
			),
		),
	},
	lists: {
		mine: defineQuery(({ ctx }) => zql.list.where(listVisible(ctx))),
	},
	tasks: {
		mine: defineQuery(({ ctx }) =>
			zql.task.where(({ exists }) =>
				exists("list", (l) => l.where(listVisible(ctx))),
			),
		),
	},
});
