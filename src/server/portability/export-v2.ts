import type {
	PortableExportV1,
	PortableRows,
} from "../../domain/portability/v1.ts";
import type {
	PortableAuthorV2,
	PortableCompletionEventV2,
	PortableExportV2,
	PortableOriginV2,
	PortableRowsV2,
} from "../../domain/portability/v2.ts";

type ImportedClaim = {
	sourceNamespace: string | null;
	sourceRowId: string | null;
	provenanceRedactedAt: Date | null;
};

type HistoricalAuthor = {
	historicalAuthorKind: "source_claim" | "unknown" | null;
	historicalAuthorNamespace: string | null;
	historicalAuthorPrincipalId: string | null;
	historicalAuthorName: string | null;
};

type HistoricalCreator = {
	historicalCreatorKind: "source_claim" | "unknown" | null;
	historicalCreatorNamespace: string | null;
	historicalCreatorPrincipalId: string | null;
	historicalCreatorName: string | null;
};

function importedAuthor(
	kind: "source_claim" | "unknown" | null,
	namespace: string | null,
	principalId: string | null,
	name: string | null,
	redactedAt: Date | null,
): PortableAuthorV2 {
	if (redactedAt || kind === "unknown") return { kind: "unknown" };
	if (kind !== "source_claim" || !namespace)
		throw new Error("Invalid imported history claim");
	return {
		kind: "source_claim",
		sourceNamespace: namespace,
		sourcePrincipalId: principalId,
		displayName: name,
	};
}

function nativeAuthor(principalId: string | null): PortableAuthorV2 {
	if (principalId === null) throw new Error("Invalid native authorship");
	return { kind: "native_user", principalId };
}

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
	row: Omit<PortableRows["comments"], "authorId"> & {
		authorId: string | null;
	} & ImportedClaim &
		HistoricalAuthor,
	namespace: string,
): PortableRowsV2["comments"] {
	const {
		authorId,
		sourceNamespace,
		sourceRowId,
		provenanceRedactedAt,
		historicalAuthorKind,
		historicalAuthorNamespace,
		historicalAuthorPrincipalId,
		historicalAuthorName,
		...content
	} = row;
	const sourceId = sourceNamespace === null ? row.id : sourceRowId;
	if (sourceId === null) throw new Error("Invalid comment provenance");
	return {
		...content,
		sourceRef: {
			namespace: sourceNamespace ?? namespace,
			collection: "comments",
			id: sourceId,
		},
		author:
			sourceNamespace === null
				? nativeAuthor(authorId)
				: importedAuthor(
						historicalAuthorKind,
						historicalAuthorNamespace,
						historicalAuthorPrincipalId,
						historicalAuthorName,
						provenanceRedactedAt,
					),
	};
}

export type ImportedCompletionEvent = Omit<
	NativeCompletionEvent,
	"actorUserId" | "recordedAt" | "origin"
> &
	ImportedClaim & {
		occurredAt: Date;
		actorKind: "source_claim" | "unknown";
		actorNamespace: string | null;
		actorPrincipalId: string | null;
		actorName: string | null;
		originKind: "source_claim" | "unknown";
		originMechanism: "member_mutation" | "capability_recipient" | null;
		originLabel: string | null;
	};

export function v2ImportedCompletionEvent(
	row: ImportedCompletionEvent,
): PortableCompletionEventV2 {
	if (row.sourceNamespace === null || row.sourceRowId === null)
		throw new Error("Invalid imported history reference");
	let origin: PortableOriginV2;
	if (row.provenanceRedactedAt || row.originKind === "unknown")
		origin = { kind: "unknown" };
	else if (row.originKind === "source_claim")
		origin = {
			kind: "source_claim",
			mechanism: row.originMechanism,
			label: row.originLabel,
		};
	else throw new Error("Invalid imported history origin");
	const common = {
		id: row.id,
		sourceRef: {
			namespace: row.sourceNamespace,
			collection: "completionEvents" as const,
			id: row.sourceRowId,
		},
		taskId: row.taskId,
		occurredAt: row.occurredAt.toISOString(),
		actor: importedAuthor(
			row.actorKind,
			row.actorNamespace,
			row.actorPrincipalId,
			row.actorName,
			row.provenanceRedactedAt,
		),
		origin,
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

export function v2Template(
	row: PortableRows["templates"] & ImportedClaim & HistoricalCreator,
	namespace: string,
): PortableRowsV2["templates"] {
	const {
		createdBy,
		sourceNamespace,
		sourceRowId,
		provenanceRedactedAt,
		historicalCreatorKind,
		historicalCreatorNamespace,
		historicalCreatorPrincipalId,
		historicalCreatorName,
		...content
	} = row;
	const sourceId = sourceNamespace === null ? row.id : sourceRowId;
	if (sourceId === null) throw new Error("Invalid template provenance");
	return {
		...content,
		sourceRef: {
			namespace: sourceNamespace ?? namespace,
			collection: "templates",
			id: sourceId,
		},
		creator:
			sourceNamespace === null
				? { kind: "native_user", principalId: createdBy }
				: importedAuthor(
						historicalCreatorKind,
						historicalCreatorNamespace,
						historicalCreatorPrincipalId,
						historicalCreatorName,
						provenanceRedactedAt,
					),
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
