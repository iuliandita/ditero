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

// Visible when the user has a membership in the owning workspace (design 2.20:
// cross-workspace by construction). Reused by every workspace-scoped table; the
// `workspace` relationship is identical across them, so widen to one concrete
// table to share a single check shape.
const workspaceVisible =
	(ctx: AuthCtx) =>
	<T extends "folder" | "label" | "list" | "template">(
		eb: ExpressionBuilder<T, Schema>,
	) =>
		(eb as ExpressionBuilder<"list", Schema>).exists("workspace", (w) =>
			w.where(({ exists }) =>
				exists("memberships", (m) => m.where("userId", ctx.id)),
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
		mine: defineQuery(({ ctx }) => zql.list.where(workspaceVisible(ctx))),
	},
	folders: {
		mine: defineQuery(({ ctx }) => zql.folder.where(workspaceVisible(ctx))),
	},
	labels: {
		mine: defineQuery(({ ctx }) => zql.label.where(workspaceVisible(ctx))),
	},
	templates: {
		mine: defineQuery(({ ctx }) => zql.template.where(workspaceVisible(ctx))),
	},
	tasks: {
		mine: defineQuery(({ ctx }) =>
			zql.task.where(({ exists }) =>
				exists("list", (l) => l.where(workspaceVisible(ctx))),
			),
		),
	},
	taskLabels: {
		mine: defineQuery(({ ctx }) =>
			zql.taskLabel.where(({ exists }) =>
				exists("task", (t) =>
					t.where(({ exists: e }) =>
						e("list", (l) => l.where(workspaceVisible(ctx))),
					),
				),
			),
		),
	},
});
