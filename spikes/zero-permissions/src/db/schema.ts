// Minimal multi-workspace schema for Spike A.
// Faithful to the ditero design (user / workspace / membership / list / task),
// trimmed to only what the permission test needs.
import { relations } from "drizzle-orm";
import { boolean, pgEnum, pgTable, text, unique } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("role", ["owner", "admin", "member", "viewer"]);
export const workspaceKindEnum = pgEnum("workspace_kind", ["personal", "shared"]);
export const listVisibilityEnum = pgEnum("list_visibility", ["workspace", "private"]);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
});

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
export const userRelations = relations(user, ({ many }) => ({
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
