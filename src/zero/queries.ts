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
	<
		T extends
			| "dashboard"
			| "folder"
			| "label"
			| "list"
			| "membership"
			| "template"
			| "view",
	>(
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
	// Co-members: memberships in any workspace the user belongs to. Powers members
	// panel, assignee/mention pickers, and client-side connection derivation.
	memberships: {
		mine: defineQuery(({ ctx }) =>
			zql.membership
				.where(workspaceVisible(ctx))
				.related("user") // name/image for pickers (drizzle-zero exposes user.id/name/image only)
				.related("workspace"),
		),
	},
	// Invites are management data: visible to owners/admins of the owning workspace.
	// The invitee never reads them via sync -- they redeem by token at the accept
	// endpoint. The role gate is the OR filter below (@rocicorp/zero exposes `and`/
	// `or`/`cmp` on the ExpressionBuilder); dropping it would leak invitee emails.
	invites: {
		forWorkspace: defineQuery(({ ctx }) =>
			zql.invite
				.where("status", "pending")
				.where(({ exists }) =>
					exists("workspace", (w) =>
						w.where(({ exists: e }) =>
							e("memberships", (m) =>
								m.where(({ and, cmp, or }) =>
									and(
										cmp("userId", ctx.id),
										or(cmp("role", "owner"), cmp("role", "admin")),
									),
								),
							),
						),
					),
				),
		),
	},
	assignees: {
		mine: defineQuery(({ ctx }) =>
			zql.taskAssignee.where(({ exists }) =>
				exists("task", (t) =>
					t.where(({ exists: e }) =>
						e("list", (l) => l.where(workspaceVisible(ctx))),
					),
				),
			),
		),
	},
	comments: {
		mine: defineQuery(({ ctx }) =>
			zql.comment
				.where(({ exists }) =>
					exists("task", (t) =>
						t.where(({ exists: e }) =>
							e("list", (l) => l.where(workspaceVisible(ctx))),
						),
					),
				)
				.related("author"),
		),
	},
	// The kid reads their own row (drives the restricted shell); the guardian reads
	// rows they own (drives the members-panel kid list). OR over userId/guardianId
	// via the ExpressionBuilder's `or`/`cmp`.
	managedAccounts: {
		mine: defineQuery(({ ctx }) =>
			zql.managedAccount.where(({ or, cmp }) =>
				or(cmp("userId", ctx.id), cmp("guardianId", ctx.id)),
			),
		),
	},
	// Visibility union: personal views the caller owns (scope personal, gate on
	// ownerId) OR workspace-shared views whose workspace the caller is a member of.
	views: {
		mine: defineQuery(({ ctx }) =>
			zql.view.where((eb) => {
				const { or, and, cmp } = eb;
				return or(
					and(cmp("scope", "personal"), cmp("ownerId", ctx.id)),
					and(cmp("scope", "workspace"), workspaceVisible(ctx)(eb)),
				);
			}),
		),
	},
	// Same visibility union as views: personal dashboards the caller owns OR
	// workspace-shared dashboards whose workspace the caller is a member of.
	dashboards: {
		mine: defineQuery(({ ctx }) =>
			zql.dashboard.where((eb) => {
				const { or, and, cmp } = eb;
				return or(
					and(cmp("scope", "personal"), cmp("ownerId", ctx.id)),
					and(cmp("scope", "workspace"), workspaceVisible(ctx)(eb)),
				);
			}),
		),
	},
	// One pref row per user (id === userId); the caller reads only their own.
	userPrefs: {
		mine: defineQuery(({ ctx }) => zql.userPref.where("id", ctx.id)),
	},
	// A habit-log row's visibility is exactly its parent habit task's visibility:
	// the habit is a task whose list's workspace the caller must be a member of.
	// Mirrors tasks.mine, one relation deeper (habit -> list).
	habitLogs: {
		mine: defineQuery(({ ctx }) =>
			zql.habitLog.where(({ exists }) =>
				exists("habit", (t) =>
					t.where(({ exists: e }) =>
						e("list", (l) => l.where(workspaceVisible(ctx))),
					),
				),
			),
		),
	},
	// Per-user karma aggregate; caller reads only their own row (id === userId).
	karma: {
		mine: defineQuery(({ ctx }) => zql.karma.where("userId", ctx.id)),
	},
	// Per-user karma ledger; caller reads only their own events.
	karmaEvents: {
		mine: defineQuery(({ ctx }) => zql.karmaEvent.where("userId", ctx.id)),
	},
	// Per-user focus/pomodoro sessions; caller reads only their own.
	focusSessions: {
		mine: defineQuery(({ ctx }) => zql.focusSession.where("userId", ctx.id)),
	},
	// Own-user only. `config` is excluded at the drizzle-zero layer, so it can
	// never reach a client even though the row itself syncs.
	notificationChannels: {
		mine: defineQuery(({ ctx }) =>
			zql.notificationChannel.where("userId", ctx.id),
		),
	},
	// Delivery state is per recipient: the caller reads the rows addressed to them,
	// never a co-assignee's independent escalation state.
	reminderStates: {
		mine: defineQuery(({ ctx }) =>
			zql.reminderState.where("recipientUserId", ctx.id),
		),
	},
});
