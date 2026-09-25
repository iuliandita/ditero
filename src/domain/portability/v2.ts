import type { PortableExportV1, PortableRows } from "./v1.ts";

export type PortableSourceRef<Collection extends string> = {
	namespace: string;
	collection: Collection;
	id: string;
};

export type PortableAuthorV2 =
	| { kind: "native_user"; principalId: string }
	| {
			kind: "source_claim";
			sourceNamespace: string;
			sourcePrincipalId: string | null;
			displayName: string | null;
	  }
	| { kind: "unknown" };

export type PortableOriginV2 =
	| {
			kind: "native";
			mechanism: "member_mutation" | "capability_recipient";
	  }
	| {
			kind: "source_claim";
			mechanism: "member_mutation" | "capability_recipient" | null;
			label: string | null;
	  }
	| { kind: "unknown" };

export type PortableCompletionEventV2 = {
	id: string;
	sourceRef: PortableSourceRef<"completionEvents">;
	taskId: string;
	occurredAt: string;
	actor: PortableAuthorV2;
	origin: PortableOriginV2;
} & (
	| {
			action: "complete" | "reopen" | "skip";
			beforeDueAt: string | null;
			beforeDueAllDay: boolean;
			beforeDone: boolean;
			afterDueAt: string | null;
			afterDone: boolean;
	  }
	| {
			action: "habit_set" | "habit_unlog";
			habitDate: string;
			beforeHabitStatus: "done" | "skipped" | null;
			afterHabitStatus: "done" | "skipped" | null;
	  }
);

export type PortableRowsV2 = Omit<PortableRows, "comments" | "templates"> & {
	comments: Omit<PortableRows["comments"], "authorId"> & {
		sourceRef: PortableSourceRef<"comments">;
		author: PortableAuthorV2;
	};
	templates: Omit<PortableRows["templates"], "createdBy"> & {
		sourceRef: PortableSourceRef<"templates">;
		creator: PortableAuthorV2;
	};
	completionEvents: PortableCompletionEventV2;
};

export type PortableExportV2 = Omit<
	PortableExportV1,
	"schemaVersion" | "boundaries" | "data"
> & {
	schemaVersion: 2;
	sourceNamespace: string;
	boundaries: Omit<PortableExportV1["boundaries"], "taskHistory"> & {
		taskHistory: "recorded-events-only";
	};
	data: { [K in keyof PortableRowsV2]: PortableRowsV2[K][] };
};
