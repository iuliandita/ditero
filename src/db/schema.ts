// Domain schema: workspace / membership / list / task.
// The `user` table is owned by Better Auth (see ./auth-schema); domain FKs point at it.
import { relations } from "drizzle-orm";
import { boolean, pgEnum, pgTable, text, unique } from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";

export * from "./auth-schema.ts";

export const roleEnum = pgEnum("role", ["owner", "admin", "member", "viewer"]);
export const workspaceKindEnum = pgEnum("workspace_kind", [
	"personal",
	"shared",
]);
export const listVisibilityEnum = pgEnum("list_visibility", [
	"workspace",
	"private",
]);

export const workspace = pgTable("workspace", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	ownerId: text("owner_id")
		.notNull()
		.references(() => user.id),
	kind: workspaceKindEnum("kind").notNull().default("shared"),
});

export const membership = pgTable(
	"membership",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspace.id),
		role: roleEnum("role").notNull().default("member"),
	},
	(t) => [unique("membership_user_workspace").on(t.userId, t.workspaceId)],
);

export const list = pgTable("list", {
	id: text("id").primaryKey(),
	workspaceId: text("workspace_id")
		.notNull()
		.references(() => workspace.id),
	ownerId: text("owner_id")
		.notNull()
		.references(() => user.id),
	title: text("title").notNull(),
	// "workspace" = visible to all workspace members; "private" = only ownerId.
	visibility: listVisibilityEnum("visibility").notNull().default("workspace"),
});

export const task = pgTable("task", {
	id: text("id").primaryKey(),
	listId: text("list_id")
		.notNull()
		.references(() => list.id),
	title: text("title").notNull(),
	done: boolean("done").notNull().default(false),
});

// Relations (drizzle-zero reads these to generate the Zero schema graph).
// Named distinctly so it merges with auth-schema's userRelations instead of
// shadowing it in the re-exported namespace.
export const userMembershipRelations = relations(user, ({ many }) => ({
	memberships: many(membership),
}));

export const workspaceRelations = relations(workspace, ({ many }) => ({
	memberships: many(membership),
	lists: many(list),
}));

export const membershipRelations = relations(membership, ({ one }) => ({
	user: one(user, { fields: [membership.userId], references: [user.id] }),
	workspace: one(workspace, {
		fields: [membership.workspaceId],
		references: [workspace.id],
	}),
}));

export const listRelations = relations(list, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [list.workspaceId],
		references: [workspace.id],
	}),
	tasks: many(task),
}));

export const taskRelations = relations(task, ({ one }) => ({
	list: one(list, { fields: [task.listId], references: [list.id] }),
}));
