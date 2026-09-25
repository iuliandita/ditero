import { z } from "zod";
import type { PortableExportV2 } from "./v2.ts";
import {
	PortableExportValidationError,
	parseBoundedPortableJson,
	portableCommentBase,
	portableDay,
	portableRows,
	portableTemplateBase,
	portableTimestamp,
	templateKindMatches,
	unchanged,
} from "./validate.ts";

const string = z.string();
const uuid = string.regex(
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
);
const mechanism = z.enum(["member_mutation", "capability_recipient"]);

const sourceRef = <
	Collection extends "comments" | "templates" | "completionEvents",
>(
	collection: Collection,
) =>
	z.strictObject({
		namespace: uuid,
		collection: z.literal(collection),
		id: string,
	});

const author = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("native_user"), principalId: string }),
	z.strictObject({
		kind: z.literal("source_claim"),
		sourceNamespace: uuid,
		sourcePrincipalId: string.nullable(),
		displayName: string.max(512).nullable(),
	}),
	z.strictObject({ kind: z.literal("unknown") }),
]);

const origin = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("native"), mechanism }),
	z.strictObject({
		kind: z.literal("source_claim"),
		mechanism: mechanism.nullable(),
		label: string.max(128).nullable(),
	}),
	z.strictObject({ kind: z.literal("unknown") }),
]);

const eventBase = {
	id: string,
	sourceRef: sourceRef("completionEvents"),
	taskId: string,
	occurredAt: portableTimestamp,
	actor: author,
	origin,
};
const taskEvent = z
	.strictObject({
		...eventBase,
		action: z.enum(["complete", "reopen", "skip"]),
		beforeDueAt: portableTimestamp.nullable(),
		beforeDueAllDay: z.boolean(),
		beforeDone: z.boolean(),
		afterDueAt: portableTimestamp.nullable(),
		afterDone: z.boolean(),
	})
	.refine(
		(event) =>
			(event.action === "complete" && !event.beforeDone) ||
			(event.action === "reopen" && event.beforeDone && !event.afterDone) ||
			(event.action === "skip" &&
				!event.afterDone &&
				event.afterDueAt !== null),
		"Invalid task history transition",
	);
const habitEvent = z
	.strictObject({
		...eventBase,
		action: z.enum(["habit_set", "habit_unlog"]),
		habitDate: portableDay,
		beforeHabitStatus: z.enum(["done", "skipped"]).nullable(),
		afterHabitStatus: z.enum(["done", "skipped"]).nullable(),
	})
	.refine(
		(event) =>
			event.action === "habit_set"
				? event.afterHabitStatus !== null &&
					event.afterHabitStatus !== event.beforeHabitStatus
				: event.beforeHabitStatus !== null && event.afterHabitStatus === null,
		"Invalid habit history transition",
	);
const event = z.union([taskEvent, habitEvent]);

const documentSchema = z.strictObject({
	format: z.literal("ditero"),
	schemaVersion: z.literal(2),
	exportedAt: portableTimestamp,
	sourceUserId: string,
	sourceNamespace: uuid,
	boundaries: z.strictObject({
		attachmentContent: z.literal("excluded"),
		encryptionKeys: z.literal("excluded"),
		credentials: z.literal("excluded"),
		managedAccounts: z.literal("excluded"),
		restoreSupported: z.literal(false),
		taskHistory: z.literal("recorded-events-only"),
	}),
	data: z.strictObject({
		principals: z.array(portableRows.principals),
		workspaces: z.array(portableRows.workspaces),
		memberships: z.array(portableRows.memberships),
		folders: z.array(portableRows.folders),
		lists: z.array(portableRows.lists),
		tasks: z.array(portableRows.tasks),
		labels: z.array(portableRows.labels),
		taskLabels: z.array(portableRows.taskLabels),
		templates: z.array(
			portableTemplateBase
				.safeExtend({ sourceRef: sourceRef("templates"), creator: author })
				.refine(templateKindMatches, "Template kind mismatch"),
		),
		assignments: z.array(portableRows.assignments),
		comments: z.array(
			portableCommentBase.safeExtend({
				sourceRef: sourceRef("comments"),
				author,
			}),
		),
		habitLogs: z.array(portableRows.habitLogs),
		views: z.array(portableRows.views),
		dashboards: z.array(portableRows.dashboards),
		userPrefs: z.array(portableRows.userPrefs),
		focusSessions: z.array(portableRows.focusSessions),
		karma: z.array(portableRows.karma),
		karmaEvents: z.array(portableRows.karmaEvents),
		attachments: z.array(portableRows.attachments),
		completionEvents: z.array(event),
	}),
}) satisfies z.ZodType<PortableExportV2>;

export function parsePortableExportV2(input: string): PortableExportV2 {
	const parsed = parseBoundedPortableJson(input);
	const validated = documentSchema.safeParse(parsed);
	if (!validated.success || !unchanged(parsed, validated.data))
		throw new PortableExportValidationError("invalid-export");
	return validated.data;
}
