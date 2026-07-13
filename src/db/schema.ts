// Domain schema: workspace / membership / list / task.
// The `user` table is owned by Better Auth (see ./auth-schema); domain FKs point at it.
import { relations, sql } from "drizzle-orm";
import {
	boolean,
	foreignKey,
	jsonb,
	pgEnum,
	pgTable,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema.ts";

export * from "./auth-schema.ts";

export const roleEnum = pgEnum("role", ["owner", "admin", "member", "viewer"]);
export const workspaceKindEnum = pgEnum("workspace_kind", [
	"personal",
	"shared",
]);
export const listKindEnum = pgEnum("list_kind", [
	"tasks",
	"shopping",
	"checklist",
	"project",
	"habits",
]);
export const completedDisplayEnum = pgEnum("completed_display", [
	"sink",
	"keep",
	"hide",
]);
export const templateKindEnum = pgEnum("template_kind", ["list", "task"]);

export const workspace = pgTable(
	"workspace",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id),
		kind: workspaceKindEnum("kind").notNull().default("shared"),
	},
	(t) => [
		uniqueIndex("workspace_personal_owner")
			.on(t.ownerId)
			.where(sql`${t.kind} = 'personal'`),
	],
);

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

export const folder = pgTable("folder", {
	id: text("id").primaryKey(),
	workspaceId: text("workspace_id")
		.notNull()
		.references(() => workspace.id),
	name: text("name").notNull(),
	sortKey: text("sort_key").notNull(),
});

export const list = pgTable("list", {
	id: text("id").primaryKey(),
	workspaceId: text("workspace_id")
		.notNull()
		.references(() => workspace.id),
	ownerId: text("owner_id")
		.notNull()
		.references(() => user.id),
	title: text("title").notNull(),
	kind: listKindEnum("kind").notNull().default("tasks"),
	icon: text("icon"), // null -> per-kind default (icon-map.ts)
	folderId: text("folder_id").references(() => folder.id),
	sortKey: text("sort_key").notNull(),
	completedDisplay: completedDisplayEnum("completed_display")
		.notNull()
		.default("sink"),
});

export const task = pgTable(
	"task",
	{
		id: text("id").primaryKey(),
		listId: text("list_id")
			.notNull()
			.references(() => list.id),
		title: text("title").notNull(),
		done: boolean("done").notNull().default(false),
		notes: text("notes"),
		dueAt: timestamp("due_at", { withTimezone: true }),
		dueAllDay: boolean("due_all_day").notNull().default(false),
		priority: smallint("priority").notNull().default(0), // 0 none, 1 low, 2 med, 3 high
		completedAt: timestamp("completed_at", { withTimezone: true }),
		sortKey: text("sort_key").notNull(),
		parentId: text("parent_id"), // 1 level deep, mutator-enforced
		quantity: text("quantity"), // shopping extras, nullable on all kinds
		unit: text("unit"),
		category: text("category"),
	},
	(t) => [
		foreignKey({
			columns: [t.parentId],
			foreignColumns: [t.id],
			name: "task_parent_fk",
		}),
	],
);

export const label = pgTable(
	"label",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspace.id),
		name: text("name").notNull(),
		color: text("color").notNull().default("gray"),
	},
	(t) => [unique("label_workspace_name").on(t.workspaceId, t.name)],
);

export const taskLabel = pgTable(
	"task_label",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => task.id, { onDelete: "cascade" }),
		labelId: text("label_id")
			.notNull()
			.references(() => label.id, { onDelete: "cascade" }),
	},
	(t) => [unique("task_label_pair").on(t.taskId, t.labelId)],
);

export const template = pgTable("template", {
	id: text("id").primaryKey(),
	workspaceId: text("workspace_id")
		.notNull()
		.references(() => workspace.id),
	kind: templateKindEnum("kind").notNull(),
	name: text("name").notNull(),
	icon: text("icon"),
	content: jsonb("content").notNull(), // TemplateContent snapshot (src/domain/template.ts)
	createdBy: text("created_by")
		.notNull()
		.references(() => user.id),
});

export const userSecret = pgTable(
	"user_secret",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		ciphertext: text("ciphertext").notNull(),
		keyFingerprint: text("key_fingerprint").notNull(),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		updatedAt: timestamp("updated_at").defaultNow().notNull(),
	},
	(t) => [unique("user_secret_user_kind").on(t.userId, t.kind)],
);

// Relations (drizzle-zero reads these to generate the Zero schema graph).
// Named distinctly so it merges with auth-schema's userRelations instead of
// shadowing it in the re-exported namespace.
export const userMembershipRelations = relations(user, ({ many }) => ({
	memberships: many(membership),
}));

export const workspaceRelations = relations(workspace, ({ many }) => ({
	memberships: many(membership),
	lists: many(list),
	folders: many(folder),
	labels: many(label),
	templates: many(template),
}));

export const membershipRelations = relations(membership, ({ one }) => ({
	user: one(user, { fields: [membership.userId], references: [user.id] }),
	workspace: one(workspace, {
		fields: [membership.workspaceId],
		references: [workspace.id],
	}),
}));

export const folderRelations = relations(folder, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [folder.workspaceId],
		references: [workspace.id],
	}),
	lists: many(list),
}));

export const listRelations = relations(list, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [list.workspaceId],
		references: [workspace.id],
	}),
	folder: one(folder, { fields: [list.folderId], references: [folder.id] }),
	tasks: many(task),
}));

export const taskRelations = relations(task, ({ one, many }) => ({
	list: one(list, { fields: [task.listId], references: [list.id] }),
	parent: one(task, {
		fields: [task.parentId],
		references: [task.id],
		relationName: "subtasks",
	}),
	subtasks: many(task, { relationName: "subtasks" }),
	taskLabels: many(taskLabel),
}));

export const labelRelations = relations(label, ({ one, many }) => ({
	workspace: one(workspace, {
		fields: [label.workspaceId],
		references: [workspace.id],
	}),
	taskLabels: many(taskLabel),
}));

export const taskLabelRelations = relations(taskLabel, ({ one }) => ({
	task: one(task, { fields: [taskLabel.taskId], references: [task.id] }),
	label: one(label, { fields: [taskLabel.labelId], references: [label.id] }),
}));

export const templateRelations = relations(template, ({ one }) => ({
	workspace: one(workspace, {
		fields: [template.workspaceId],
		references: [workspace.id],
	}),
}));
