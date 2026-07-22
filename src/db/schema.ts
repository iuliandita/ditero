// Domain schema: workspace / membership / list / task.
// The `user` table is owned by Better Auth (see ./auth-schema); domain FKs point at it.
import { relations, sql } from "drizzle-orm";
import {
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { CHANNEL_ERROR_CODES } from "../domain/notification-retry.ts";
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
export const inviteStatusEnum = pgEnum("invite_status", [
	"pending",
	"accepted",
	"revoked",
]);
export const attachKindEnum = pgEnum("attach_kind", ["assign", "mention"]);
export const viewScopeEnum = pgEnum("view_scope", ["personal", "workspace"]);
export const keymapProfileEnum = pgEnum("keymap_profile", ["default", "vim"]);
export const habitLogStatusEnum = pgEnum("habit_log_status", [
	"done",
	"skipped",
]);
export const focusKindEnum = pgEnum("focus_kind", ["work", "break"]);
export const dashboardScopeEnum = pgEnum("dashboard_scope", [
	"personal",
	"workspace",
]);
export const channelKindEnum = pgEnum("channel_kind", [
	"ntfy",
	"telegram",
	"discord",
	"slack",
	"email",
]);
// Enum, not text: the column is Zero-synced, and a text column would let a
// provider error body (credentials and all) reach every client of that user.
// Values live in domain/notification-retry.ts with the mapping that produces
// them, so the two cannot drift.
export const channelErrorCodeEnum = pgEnum(
	"channel_error_code",
	CHANNEL_ERROR_CODES,
);
export const reminderStatusEnum = pgEnum("reminder_status", [
	"pending",
	"deferred",
	"acked",
	"escalated",
	"failed",
	"expired",
]);
export const outboxStatusEnum = pgEnum("outbox_status", [
	"queued",
	"sending",
	"sent",
	"failed",
	"abandoned",
]);

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
		rrule: text("rrule"), // null => non-recurring; RFC 5545 RRULE
		recurrenceRelative: boolean("recurrence_relative").notNull().default(false), // true => next due from completion, not schedule
		reminderTime: text("reminder_time"), // "HH:MM" local, nullable
		repeatEveryMin: smallint("repeat_every_min"), // escalation repeat interval; null => inherit user-level default
		maxRepeats: smallint("max_repeats"), // escalation repeat cap; null => inherit user-level default
		fallbackUserId: text("fallback_user_id").references(() => user.id, {
			onDelete: "set null",
		}),
		urgent: boolean("urgent").notNull().default(false),
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

export const invite = pgTable(
	"invite",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspace.id),
		role: roleEnum("role").notNull().default("member"), // role the redeemer receives
		email: text("email"), // null => open link/code invite
		token: text("token").notNull(), // unguessable (uuid v4); redeem key
		status: inviteStatusEnum("status").notNull().default("pending"),
		expiresAt: timestamp("expires_at", { withTimezone: true }), // null => no expiry
		maxUses: smallint("max_uses"), // null => unlimited (link/code)
		uses: smallint("uses").notNull().default(0),
		attachTaskId: text("attach_task_id").references(() => task.id, {
			onDelete: "set null",
		}),
		attachKind: attachKindEnum("attach_kind"), // set iff attachTaskId set
		createdBy: text("created_by")
			.notNull()
			.references(() => user.id),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [uniqueIndex("invite_token").on(t.token)],
);

export const taskAssignee = pgTable(
	"task_assignee",
	{
		id: text("id").primaryKey(), // deterministic `taskId:userId`
		taskId: text("task_id")
			.notNull()
			.references(() => task.id, { onDelete: "cascade" }),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(t) => [unique("task_assignee_pair").on(t.taskId, t.userId)],
);

export const comment = pgTable("comment", {
	id: text("id").primaryKey(),
	taskId: text("task_id")
		.notNull()
		.references(() => task.id, { onDelete: "cascade" }),
	authorId: text("author_id")
		.notNull()
		.references(() => user.id),
	body: text("body").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	editedAt: timestamp("edited_at", { withTimezone: true }),
});

export const managedAccount = pgTable("managed_account", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.unique()
		.references(() => user.id, { onDelete: "cascade" }), // the kid
	guardianId: text("guardian_id")
		.notNull()
		.references(() => user.id),
	restricted: boolean("restricted").notNull().default(true),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const view = pgTable("view", {
	id: text("id").primaryKey(),
	ownerId: text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	// null => personal / cross-workspace view; set => workspace-shared
	workspaceId: text("workspace_id").references(() => workspace.id),
	name: text("name").notNull(),
	icon: text("icon"),
	scope: viewScopeEnum("scope").notNull().default("personal"),
	filter: jsonb("filter").notNull(), // FilterGroup AST (src/domain/view-filter.ts, later task)
	display: jsonb("display").notNull(), // ViewDisplay (src/domain/view-filter.ts, later task)
	sortKey: text("sort_key").notNull(), // fractional sort-key for sidebar order (matches folder/list/task)
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const userPref = pgTable("user_pref", {
	// id === userId (one row per user)
	id: text("id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	keymap: jsonb("keymap").notNull().default(sql`'{}'::jsonb`), // Record<commandId, binding[]>
	keymapProfile: keymapProfileEnum("keymap_profile")
		.notNull()
		.default("default"),
	homeViewRef: text("home_view_ref"), // built-in id ("today"...) or view.id; null => "today"
	pinnedViews: jsonb("pinned_views").notNull().default(sql`'[]'::jsonb`), // ordered refs
	karmaGoals: jsonb("karma_goals"), // { daily, weekly } | null
	vacation: jsonb("vacation"), // { active, until? } | null
	focus: jsonb("focus"), // { workMin, breakMin, longBreakMin, roundsPerLongBreak, autoCycle } | null
	timezone: text("timezone").notNull().default("UTC"),
	quietHours: jsonb("quiet_hours"), // { start: "HH:MM", end: "HH:MM" } | null
	escalationDefaults: jsonb("escalation_defaults"), // { repeatEveryMin, maxRepeats, fallbackUserId } | null
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
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

export const habitLog = pgTable(
	"habit_log",
	{
		id: text("id").primaryKey(),
		habitId: text("habit_id")
			.notNull()
			.references(() => task.id, { onDelete: "cascade" }),
		date: text("date").notNull(), // "YYYY-MM-DD" local occurrence date
		status: habitLogStatusEnum("status").notNull(),
		// Karma points currently attributed to this row's done state (0 when
		// skipped/not-awarded). Recorded so compensation/idempotency reuse the
		// exact awarded amount instead of recomputing from live priority/status.
		karmaDelta: integer("karma_delta").notNull().default(0),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [unique("habit_log_habit_date").on(t.habitId, t.date)],
);

export const karma = pgTable("karma", {
	userId: text("user_id")
		.primaryKey()
		.references(() => user.id, { onDelete: "cascade" }),
	points: integer("points").notNull().default(0),
	level: integer("level").notNull().default(1),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const karmaEvent = pgTable("karma_event", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	date: text("date").notNull(), // "YYYY-MM-DD" local
	delta: integer("delta").notNull(),
	reason: text("reason").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const focusSession = pgTable("focus_session", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	taskId: text("task_id").references(() => task.id, { onDelete: "set null" }),
	kind: focusKindEnum("kind").notNull(),
	startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
	durationSec: integer("duration_sec").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const dashboard = pgTable("dashboard", {
	id: text("id").primaryKey(),
	ownerId: text("owner_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	// null => personal / cross-workspace dashboard; set => workspace-shared
	workspaceId: text("workspace_id").references(() => workspace.id),
	scope: dashboardScopeEnum("scope").notNull().default("personal"),
	name: text("name").notNull(),
	icon: text("icon"),
	panels: jsonb("panels").notNull().default(sql`'[]'::jsonb`), // Panel[] (validated via panelsSchema in mutators)
	sortKey: text("sort_key").notNull(), // fractional sort-key for sidebar order (matches view)
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const notificationChannel = pgTable(
	"notification_channel",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		kind: channelKindEnum("kind").notNull(),
		// Never synced (omitted at the drizzle-zero layer). Holds channel
		// credentials: the secret fields are enveloped at rest via the
		// field-encryption path (security/channel-config.ts); the public fields
		// (ntfy serverUrl/topic) stay readable.
		config: jsonb("config").notNull(),
		enabled: boolean("enabled").notNull().default(true),
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
		// Written only by the worker's completion path: set on a permanent
		// delivery failure, cleared on the next success. verifiedAt alone would
		// keep rendering "Verified" for a credential that has started failing.
		lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
		lastErrorCode: channelErrorCodeEnum("last_error_code"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [unique("notification_channel_user_kind").on(t.userId, t.kind)],
);

export const reminderState = pgTable(
	"reminder_state",
	{
		id: text("id").primaryKey(),
		taskId: text("task_id")
			.notNull()
			.references(() => task.id, { onDelete: "cascade" }),
		occurrenceAt: timestamp("occurrence_at", { withTimezone: true }).notNull(),
		recipientUserId: text("recipient_user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		status: reminderStatusEnum("status").notNull().default("pending"),
		fireCount: smallint("fire_count").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		deferredUntil: timestamp("deferred_until", { withTimezone: true }),
		firedLate: boolean("fired_late").notNull().default(false),
		ackedAt: timestamp("acked_at", { withTimezone: true }),
		ackedVia: text("acked_via"), // channelKindEnum value or "in_app"; not an enum since it spans both
		// What the ack actually did: "completed" (task marked done / advanced),
		// "logged" (habit occurrence recorded), "ack_only" (viewer silenced the
		// reminder, nothing written). Without it a missed-medication review cannot
		// tell "acked and done" from "acked and untouched".
		ackOutcome: text("ack_outcome"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		unique("reminder_state_occurrence").on(
			t.taskId,
			t.occurrenceAt,
			t.recipientUserId,
		),
		index("reminder_state_sweep").on(t.status, t.nextAttemptAt),
		index("reminder_state_deferred").on(t.status, t.deferredUntil),
		// Ack terminates every sibling on the same occurrence.
		index("reminder_state_siblings").on(t.taskId, t.occurrenceAt),
	],
);

export const notificationOutbox = pgTable(
	"notification_outbox",
	{
		id: text("id").primaryKey(),
		reminderStateId: text("reminder_state_id").references(
			() => reminderState.id,
			{ onDelete: "cascade" },
		),
		recipientUserId: text("recipient_user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		channelKind: channelKindEnum("channel_kind").notNull(),
		payload: jsonb("payload").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		status: outboxStatusEnum("status").notNull().default("queued"),
		attempts: smallint("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		claimedBy: text("claimed_by"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		unique("notification_outbox_idempotency").on(t.idempotencyKey),
		index("notification_outbox_claim").on(t.status, t.nextAttemptAt),
		index("notification_outbox_reclaim").on(t.status, t.claimedAt),
		index("notification_outbox_recipient").on(t.recipientUserId, t.status),
		// The prune sweep exists to bound table growth; it was the one job
		// filtering on an unindexed predicate.
		index("notification_outbox_prune").on(t.status, t.createdAt),
	],
);

export const deliveryAttempt = pgTable("delivery_attempt", {
	id: text("id").primaryKey(),
	outboxId: text("outbox_id")
		.notNull()
		.references(() => notificationOutbox.id, { onDelete: "cascade" }),
	attemptNo: smallint("attempt_no").notNull(),
	providerStatus: smallint("provider_status"),
	retryClass: text("retry_class").notNull(), // not an enum; taxonomy still being designed, avoids a migration per change
	error: text("error"), // truncated + redacted by the delivery worker before write
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export const ackCapability = pgTable("ack_capability", {
	id: text("id").primaryKey(),
	tokenHash: text("token_hash").notNull().unique(),
	reminderStateId: text("reminder_state_id")
		.notNull()
		.references(() => reminderState.id, { onDelete: "cascade" }),
	recipientUserId: text("recipient_user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	action: text("action").notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	consumedAt: timestamp("consumed_at", { withTimezone: true }),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

// Server-only token bucket. The ack route is an unauthenticated public endpoint
// on a multi-replica deployment, so an in-process limiter would bound nothing.
// Deliberately absent from drizzle-zero.config.ts.
export const rateBucket = pgTable("rate_bucket", {
	key: text("key").primaryKey(),
	tokens: integer("tokens").notNull(),
	refilledAt: timestamp("refilled_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
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
	assignees: many(taskAssignee),
	comments: many(comment),
	habitLogs: many(habitLog),
	focusSessions: many(focusSession),
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

export const inviteRelations = relations(invite, ({ one }) => ({
	workspace: one(workspace, {
		fields: [invite.workspaceId],
		references: [workspace.id],
	}),
}));

export const taskAssigneeRelations = relations(taskAssignee, ({ one }) => ({
	task: one(task, { fields: [taskAssignee.taskId], references: [task.id] }),
	user: one(user, { fields: [taskAssignee.userId], references: [user.id] }),
}));

export const commentRelations = relations(comment, ({ one }) => ({
	task: one(task, { fields: [comment.taskId], references: [task.id] }),
	author: one(user, { fields: [comment.authorId], references: [user.id] }),
}));

export const managedAccountRelations = relations(managedAccount, ({ one }) => ({
	account: one(user, {
		fields: [managedAccount.userId],
		references: [user.id],
		relationName: "managedAccount",
	}),
	guardian: one(user, {
		fields: [managedAccount.guardianId],
		references: [user.id],
		relationName: "managedGuardian",
	}),
}));

export const viewRelations = relations(view, ({ one }) => ({
	owner: one(user, { fields: [view.ownerId], references: [user.id] }),
	workspace: one(workspace, {
		fields: [view.workspaceId],
		references: [workspace.id],
	}),
}));

export const userPrefRelations = relations(userPref, ({ one }) => ({
	user: one(user, { fields: [userPref.id], references: [user.id] }),
}));

export const habitLogRelations = relations(habitLog, ({ one }) => ({
	habit: one(task, { fields: [habitLog.habitId], references: [task.id] }),
}));

export const karmaRelations = relations(karma, ({ one }) => ({
	user: one(user, { fields: [karma.userId], references: [user.id] }),
}));

export const karmaEventRelations = relations(karmaEvent, ({ one }) => ({
	user: one(user, { fields: [karmaEvent.userId], references: [user.id] }),
}));

export const focusSessionRelations = relations(focusSession, ({ one }) => ({
	user: one(user, { fields: [focusSession.userId], references: [user.id] }),
	task: one(task, { fields: [focusSession.taskId], references: [task.id] }),
}));

export const dashboardRelations = relations(dashboard, ({ one }) => ({
	owner: one(user, { fields: [dashboard.ownerId], references: [user.id] }),
	workspace: one(workspace, {
		fields: [dashboard.workspaceId],
		references: [workspace.id],
	}),
}));

export const notificationChannelRelations = relations(
	notificationChannel,
	({ one }) => ({
		user: one(user, {
			fields: [notificationChannel.userId],
			references: [user.id],
		}),
	}),
);

export const reminderStateRelations = relations(
	reminderState,
	({ one, many }) => ({
		task: one(task, {
			fields: [reminderState.taskId],
			references: [task.id],
		}),
		recipient: one(user, {
			fields: [reminderState.recipientUserId],
			references: [user.id],
		}),
		outboxEntries: many(notificationOutbox),
		ackCapabilities: many(ackCapability),
	}),
);

export const notificationOutboxRelations = relations(
	notificationOutbox,
	({ one, many }) => ({
		reminderState: one(reminderState, {
			fields: [notificationOutbox.reminderStateId],
			references: [reminderState.id],
		}),
		recipient: one(user, {
			fields: [notificationOutbox.recipientUserId],
			references: [user.id],
		}),
		deliveryAttempts: many(deliveryAttempt),
	}),
);

export const deliveryAttemptRelations = relations(
	deliveryAttempt,
	({ one }) => ({
		outbox: one(notificationOutbox, {
			fields: [deliveryAttempt.outboxId],
			references: [notificationOutbox.id],
		}),
	}),
);

export const ackCapabilityRelations = relations(ackCapability, ({ one }) => ({
	reminderState: one(reminderState, {
		fields: [ackCapability.reminderStateId],
		references: [reminderState.id],
	}),
	recipient: one(user, {
		fields: [ackCapability.recipientUserId],
		references: [user.id],
	}),
}));
