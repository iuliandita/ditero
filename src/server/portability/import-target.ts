import { hashImportValue } from "../../domain/portability/import-digest.ts";
import type { PortableJson } from "../../domain/portability/v1.ts";

// Keep target fingerprints on the portable fields, not database bookkeeping.
export const IMPORT_TARGETS = {
	folders: {
		table: "folder",
		fields: ["id", "workspaceId", "name", "sortKey"],
	},
	lists: {
		table: "list",
		fields: [
			"id",
			"workspaceId",
			"ownerId",
			"title",
			"kind",
			"icon",
			"folderId",
			"sortKey",
			"completedDisplay",
		],
	},
	labels: {
		table: "label",
		fields: ["id", "workspaceId", "name", "color"],
	},
	tasks: {
		table: "task",
		fields: [
			"id",
			"listId",
			"title",
			"done",
			"notes",
			"dueAt",
			"dueAllDay",
			"priority",
			"completedAt",
			"sortKey",
			"parentId",
			"quantity",
			"unit",
			"category",
			"rrule",
			"recurrenceRelative",
			"reminderTime",
			"repeatEveryMin",
			"maxRepeats",
			"fallbackUserId",
			"urgent",
		],
	},
	taskLabels: {
		table: "task_label",
		fields: ["id", "taskId", "labelId"],
	},
	assignments: {
		table: "task_assignee",
		fields: ["id", "taskId", "userId"],
	},
} as const;

export type ImportTargetCollection = keyof typeof IMPORT_TARGETS;

export function importTargetProjection(
	collection: ImportTargetCollection,
	row: Record<string, unknown>,
): Record<string, PortableJson> {
	const projection: Record<string, PortableJson> = {};
	for (const field of IMPORT_TARGETS[collection].fields) {
		const column = field.replace(
			/[A-Z]/g,
			(letter) => `_${letter.toLowerCase()}`,
		);
		const value = row[column];
		if (
			collection === "tasks" &&
			(field === "dueAt" || field === "completedAt")
		) {
			if (value === null) projection[field] = null;
			else if (value instanceof Date && Number.isFinite(value.getTime()))
				projection[field] = value.toISOString();
			else throw new Error("Invalid import target timestamp");
		} else if (
			value === null ||
			typeof value === "string" ||
			typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value))
		) {
			projection[field] = value;
		} else throw new Error("Invalid import target field");
	}
	return projection;
}

export function digestImportTarget(
	collection: ImportTargetCollection,
	row: Record<string, unknown>,
	checkpoint: () => void,
) {
	return hashImportValue(
		"ditero-import-target-v1",
		[collection, importTargetProjection(collection, row)],
		checkpoint,
	);
}
