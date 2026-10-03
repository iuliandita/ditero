import { z } from "zod";
import { resolvePanelSource } from "../domain/dashboard.ts";
import { PUBLIC_API_ID } from "../domain/public-api.ts";
import {
	publicApiProfileSchema,
	publicApiResourceSchemas,
} from "../domain/public-api-resources.ts";
import {
	type ApiTaskCreate,
	parseApiTaskCreate,
} from "../domain/public-api-writes.ts";
import {
	type FilterNode,
	resolveWorkspaceScope,
	taskMatchesFilter,
} from "../domain/view-filter.ts";
import { wallClockToInstant } from "../domain/zoned.ts";

const selector = z.union([
	z.object({ id: PUBLIC_API_ID }).strict(),
	z.object({ name: z.string().trim().min(1).max(500) }).strict(),
]);
export const taskIntentSchema = z
	.object({
		title: z.string().trim().min(1).max(500),
		notes: z.string().max(32_768).nullable().default(null),
		target: z
			.object({
				kind: z.enum(["list", "dashboard"]),
				selector,
				personal: z.boolean().default(false),
				listId: PUBLIC_API_ID.optional(),
			})
			.strict(),
		due: z
			.object({
				day: z.string().regex(/^(today|tomorrow|\d{4}-\d{2}-\d{2})$/),
				time: z
					.string()
					.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
					.optional(),
			})
			.strict()
			.nullable()
			.default(null),
		priority: z.number().int().min(0).max(3).default(0),
		assignees: z.array(selector).max(20).default([]),
		labels: z.array(selector).max(50).default([]),
	})
	.strict();
export type TaskIntent = z.infer<typeof taskIntentSchema>;
export const taskPlanSnapshotSchema = z
	.object({
		profile: publicApiProfileSchema,
		workspaces: z.array(publicApiResourceSchemas.workspaces),
		lists: z.array(publicApiResourceSchemas.lists),
		people: z.array(publicApiResourceSchemas.people),
		labels: z.array(publicApiResourceSchemas.labels),
		views: z.array(publicApiResourceSchemas.views),
		dashboards: z.array(publicApiResourceSchemas.dashboards),
	})
	.strict();
export type TaskPlanSnapshot = z.infer<typeof taskPlanSnapshotSchema>;
type Choice = { id: string; name: string };
export class TaskPlanError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly choices: Choice[] = [],
	) {
		super(message);
	}
}

function select<T extends { id: string }>(
	rows: T[],
	reference: z.infer<typeof selector>,
	name: (row: T) => string,
	code: string,
): T {
	const matches = rows.filter((row) =>
		"id" in reference
			? row.id === reference.id
			: name(row).normalize("NFC") === reference.name.normalize("NFC"),
	);
	if (matches.length !== 1)
		throw new TaskPlanError(
			matches.length ? `ambiguous-${code}` : `${code}-not-found`,
			matches.length
				? `Choose an explicit ${code} ID.`
				: `No authorized ${code} matches.`,
			matches.map((row) => ({ id: row.id, name: name(row) })),
		);
	return matches[0];
}

// Only list predicates constrain destination discovery. Other predicates are
// verified against the completed task proposal before it can become ready.
function possibleList(node: FilterNode, listId: string): boolean {
	if ("op" in node) {
		if (!node.conditions.length) return true;
		return node.op === "and"
			? node.conditions.every((child) => possibleList(child, listId))
			: node.conditions.some((child) => possibleList(child, listId));
	}
	if (node.field !== "list") return true;
	if (node.operator === "eq") return node.value === listId;
	if (node.operator === "in" && Array.isArray(node.value))
		return node.value.includes(listId);
	throw new TaskPlanError(
		"unsupported-dashboard-filter",
		"The dashboard list filter is unsupported.",
	);
}

function dueDate(
	intent: TaskIntent,
	snapshot: TaskPlanSnapshot,
): string | null {
	if (!intent.due) return null;
	if (!snapshot.profile.timezoneChosen)
		throw new TaskPlanError(
			"timezone-required",
			"Choose an account timezone before planning a dated task.",
		);
	let day = intent.due.day;
	try {
		if (day === "today" || day === "tomorrow") {
			const parts = new Intl.DateTimeFormat("en-US", {
				timeZone: snapshot.profile.timezone,
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
			}).formatToParts(new Date(snapshot.profile.serverTime));
			const part = (type: string) =>
				Number(parts.find((p) => p.type === type)?.value);
			const date = new Date(
				Date.UTC(
					part("year"),
					part("month") - 1,
					part("day") + (day === "tomorrow" ? 1 : 0),
				),
			);
			day = date.toISOString().slice(0, 10);
		}
		// Noon retains the selected local calendar day for date-only tasks.
		const instant = wallClockToInstant(
			day,
			intent.due.time ?? "12:00",
			snapshot.profile.timezone,
		);
		const parts = new Intl.DateTimeFormat("en-CA", {
			timeZone: snapshot.profile.timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).formatToParts(instant);
		const value = (type: string) => parts.find((p) => p.type === type)?.value;
		if (`${value("year")}-${value("month")}-${value("day")}` !== day)
			throw new Error("Skipped day");
		return instant.toISOString();
	} catch {
		throw new TaskPlanError(
			"invalid-due-date",
			"The due date cannot be resolved in the account timezone.",
		);
	}
}

export function planTask(
	rawIntent: unknown,
	rawSnapshot: unknown,
): {
	version: 1;
	task: ApiTaskCreate;
	target: { kind: "list" | "dashboard"; id: string };
	timezone: string;
	resolvedAt: string;
} {
	const intent = taskIntentSchema.parse(rawIntent);
	const snapshot = taskPlanSnapshotSchema.parse(rawSnapshot);
	if (snapshot.profile.tokenAccess !== "write")
		throw new TaskPlanError(
			"write-token-required",
			"A write token is required to create a task.",
		);
	const ctx = {
		userId: snapshot.profile.id,
		now: new Date(snapshot.profile.serverTime),
		membershipWorkspaceIds: snapshot.workspaces.map((w) => w.id),
	};
	const writable = snapshot.lists.filter((list) =>
		snapshot.workspaces.some(
			(w) => w.id === list.workspaceId && w.role !== "viewer",
		),
	);
	const personal = (workspaceId: string) =>
		snapshot.workspaces.some(
			(w) =>
				w.id === workspaceId &&
				w.kind === "personal" &&
				w.ownerId === ctx.userId,
		);
	const lists = intent.target.personal
		? writable.filter((list) => personal(list.workspaceId))
		: writable;
	let list: TaskPlanSnapshot["lists"][number];
	let target: { kind: "list" | "dashboard"; id: string };
	let sources: ReturnType<typeof resolvePanelSource>[] = [];
	if (intent.target.kind === "list") {
		list = select(lists, intent.target.selector, (row) => row.title, "list");
		if (intent.target.listId && intent.target.listId !== list.id)
			throw new TaskPlanError(
				"target-conflict",
				"The explicit list conflicts with the selected target.",
			);
		target = { kind: "list", id: list.id };
	} else {
		const dashboards = snapshot.dashboards.filter(
			(d) =>
				!intent.target.personal ||
				(d.scope === "personal" && d.ownerId === ctx.userId),
		);
		const dashboard = select(
			dashboards,
			intent.target.selector,
			(row) => row.name,
			"dashboard",
		);
		target = { kind: "dashboard", id: dashboard.id };
		const views = new Map(snapshot.views.map((v) => [v.id, v]));
		sources = dashboard.panels
			.filter((p) => p.type === "tasks")
			.map((p) =>
				p.type === "tasks" ? resolvePanelSource(p.source, views) : null,
			);
		if (sources.some((source) => source === null))
			throw new TaskPlanError(
				"dashboard-view-unavailable",
				"A dashboard task view is unavailable.",
			);
		const candidates = lists.filter((candidate) =>
			sources.some(
				(source) =>
					source &&
					resolveWorkspaceScope(source.workspaceScope, ctx).has(
						candidate.workspaceId,
					) &&
					possibleList(source.filter, candidate.id),
			),
		);
		if (!intent.target.listId && candidates.length > 1)
			throw new TaskPlanError(
				"ambiguous-backing-list",
				"Choose a backing list ID for this dashboard.",
				candidates.map((row) => ({ id: row.id, name: row.title })),
			);
		list = select(
			candidates,
			{ id: intent.target.listId ?? candidates[0]?.id ?? "" },
			(row) => row.title,
			"backing-list",
		);
	}
	if (list.kind === "habits")
		throw new TaskPlanError(
			"habit-schedule-required",
			"Habit creation requires a schedule, which this task workflow does not support.",
		);
	const assigneeIds = intent.assignees.map(
		(reference) =>
			select(
				snapshot.people.filter((p) =>
					p.workspaceIds.includes(list.workspaceId),
				),
				reference,
				(p) => p.name,
				"assignee",
			).id,
	);
	const labelIds = intent.labels.map(
		(reference) =>
			select(
				snapshot.labels.filter((l) => l.workspaceId === list.workspaceId),
				reference,
				(l) => l.name,
				"label",
			).id,
	);
	const dueAt = dueDate(intent, snapshot);
	const task = parseApiTaskCreate({
		listId: list.id,
		title: intent.title,
		notes: intent.notes,
		dueAt,
		dueAllDay: intent.due !== null && intent.due.time === undefined,
		priority: intent.priority,
		assigneeIds,
		labelIds,
	});
	if (target.kind === "dashboard") {
		try {
			const matches = sources.some(
				(source) =>
					source &&
					resolveWorkspaceScope(source.workspaceScope, ctx).has(
						list.workspaceId,
					) &&
					taskMatchesFilter(
						{
							...task,
							id: "proposal",
							workspaceId: list.workspaceId,
							done: false,
							dueAt: dueAt ? new Date(dueAt) : null,
							kind: list.kind,
							folderId: list.folderId,
						},
						source.filter,
						ctx,
					),
			);
			if (!matches)
				throw new TaskPlanError(
					"dashboard-filter-mismatch",
					"The proposed task does not match a dashboard task panel.",
				);
		} catch (error) {
			if (error instanceof TaskPlanError) throw error;
			throw new TaskPlanError(
				"unsupported-dashboard-filter",
				"The dashboard filter cannot be evaluated safely.",
			);
		}
	}
	return {
		version: 1,
		task,
		target,
		timezone: snapshot.profile.timezone,
		resolvedAt: snapshot.profile.serverTime,
	};
}
