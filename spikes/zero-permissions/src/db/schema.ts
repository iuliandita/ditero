// Minimal multi-workspace schema for Spike A.
// Faithful to the ditero design (user / workspace / membership / list / task),
// trimmed to only what the permission test needs.
import { relations } from "drizzle-orm";
import { boolean, integer, pgEnum, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

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

// --- Spike B: notification/escalation (BACKEND-owned; NOT in the Zero schema) ---
// Ownership split: the backend owns these via drizzle; task.done acks go through
// the Zero mutator. That is the two-writer seam Spike B proves.

export const channelKindEnum = pgEnum("channel_kind", ["ntfy", "telegram"]);
export const reminderStateEnum = pgEnum("reminder_state", [
  "pending",
  "fired",
  "acked",
  "escalated",
]);

// Per-user delivery channel (which topic/chat to notify).
export const userChannel = pgTable("user_channel", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  kind: channelKindEnum("kind").notNull(),
  target: text("target").notNull(), // ntfy topic, or telegram chat id
});

// A reminder tied to a task, with escalation policy.
export const reminder = pgTable("reminder", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => task.id),
  userId: text("user_id")
    .notNull()
    .references(() => user.id), // recipient
  fireAt: timestamp("fire_at", { withTimezone: true }).notNull(),
  state: reminderStateEnum("state").notNull().default("pending"),
  intervalSec: integer("interval_sec").notNull().default(60),
  maxRepeats: integer("max_repeats").notNull().default(3),
  repeatCount: integer("repeat_count").notNull().default(0),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  fallbackUserId: text("fallback_user_id").references(() => user.id),
  ackedBy: text("acked_by").references(() => user.id),
  ackedAt: timestamp("acked_at", { withTimezone: true }),
});
