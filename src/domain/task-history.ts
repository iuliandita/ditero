import { z } from "zod";
import { COMPLETION_HISTORY_PAGE_SIZE } from "./completion-history.ts";

export const historyCursorSchema = z
	.object({
		recordedAt: z.number().int().min(-62135596800000).max(253402300799999),
		sourceKind: z.enum(["native", "imported"]),
		id: z.string().max(2048),
	})
	.strict();
export type HistoryCursor = z.infer<typeof historyCursorSchema>;
const claim = z
	.object({
		kind: z.enum(["native_user", "source_claim", "unknown"]),
		displayName: z.string().max(1024).nullable(),
	})
	.strict();
const row = historyCursorSchema
	.extend({
		action: z.enum(["complete", "reopen", "skip", "habit_set", "habit_unlog"]),
		origin: z
			.object({
				kind: z.enum(["native", "source_claim", "unknown"]),
				mechanism: z
					.enum(["member_mutation", "capability_recipient"])
					.nullable(),
				label: z.string().max(256).nullable(),
			})
			.strict(),
		actor: claim,
		beforeDueAt: z.number().nullable(),
		beforeDueAllDay: z.boolean().nullable(),
		habitDate: z.string().nullable(),
		afterHabitStatus: z.enum(["done", "skipped"]).nullable(),
		provenanceRedactedAt: z.number().nullable(),
	})
	.strict()
	.superRefine((value, context) => {
		if (
			(value.sourceKind === "imported" &&
				(value.actor.kind === "native_user" ||
					value.origin.kind === "native")) ||
			(value.sourceKind === "native" && value.origin.kind !== "native")
		)
			context.addIssue({
				code: "custom",
				message: "Invalid history provenance",
			});
	});
export type HistoryRow = z.infer<typeof row>;
export const historyPageSchema = z
	.object({
		rows: z.array(row).max(COMPLETION_HISTORY_PAGE_SIZE),
		nextCursor: historyCursorSchema.nullable(),
	})
	.strict();
export type HistoryPage = z.infer<typeof historyPageSchema>;

export function parseHistoryCursor(value: string | null): HistoryCursor | null {
	if (value === null) return null;
	if (value.length > 4096) throw new Error("Invalid history cursor");
	return historyCursorSchema.parse(JSON.parse(value));
}
