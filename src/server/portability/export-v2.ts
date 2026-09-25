import type {
	PortableExportV1,
	PortableRows,
} from "../../domain/portability/v1.ts";
import type {
	PortableCompletionEventV2,
	PortableExportV2,
	PortableRowsV2,
} from "../../domain/portability/v2.ts";

export function v2Document(
	v1: PortableExportV1,
	namespace: string,
): PortableExportV2 {
	return {
		format: v1.format,
		schemaVersion: 2,
		exportedAt: v1.exportedAt,
		sourceUserId: v1.sourceUserId,
		sourceNamespace: namespace,
		boundaries: { ...v1.boundaries, taskHistory: "recorded-events-only" },
		data: {
			...v1.data,
			comments: [],
			templates: [],
			completionEvents: [],
		},
	};
}

export function v2Comment(
	row: PortableRows["comments"],
	namespace: string,
): PortableRowsV2["comments"] {
	const { authorId, ...content } = row;
	return {
		...content,
		sourceRef: { namespace, collection: "comments", id: row.id },
		author: { kind: "native_user", principalId: authorId },
	};
}

export function v2Template(
	row: PortableRows["templates"],
	namespace: string,
): PortableRowsV2["templates"] {
	const { createdBy, ...content } = row;
	return {
		...content,
		sourceRef: { namespace, collection: "templates", id: row.id },
		creator: { kind: "native_user", principalId: createdBy },
	};
}

export type NativeCompletionEvent = {
	id: string;
	taskId: string;
	actorUserId: string;
	recordedAt: Date;
	origin: "member_mutation" | "capability_recipient";
	action: "complete" | "reopen" | "skip" | "habit_set" | "habit_unlog";
	beforeDueAt: Date | null;
	beforeDueAllDay: boolean | null;
	beforeDone: boolean | null;
	afterDueAt: Date | null;
	afterDone: boolean | null;
	habitDate: string | null;
	beforeHabitStatus: "done" | "skipped" | null;
	afterHabitStatus: "done" | "skipped" | null;
};

export function v2CompletionEvent(
	row: NativeCompletionEvent,
	namespace: string,
): PortableCompletionEventV2 {
	const common = {
		id: row.id,
		sourceRef: {
			namespace,
			collection: "completionEvents" as const,
			id: row.id,
		},
		taskId: row.taskId,
		occurredAt: row.recordedAt.toISOString(),
		actor: { kind: "native_user" as const, principalId: row.actorUserId },
		origin: { kind: "native" as const, mechanism: row.origin },
	};
	if (row.action === "habit_set" || row.action === "habit_unlog") {
		if (row.habitDate === null) throw new Error("Invalid completion history");
		return {
			...common,
			action: row.action,
			habitDate: row.habitDate,
			beforeHabitStatus: row.beforeHabitStatus,
			afterHabitStatus: row.afterHabitStatus,
		};
	}
	if (
		row.beforeDueAllDay === null ||
		row.beforeDone === null ||
		row.afterDone === null
	)
		throw new Error("Invalid completion history");
	return {
		...common,
		action: row.action,
		beforeDueAt: row.beforeDueAt?.toISOString() ?? null,
		beforeDueAllDay: row.beforeDueAllDay,
		beforeDone: row.beforeDone,
		afterDueAt: row.afterDueAt?.toISOString() ?? null,
		afterDone: row.afterDone,
	};
}
