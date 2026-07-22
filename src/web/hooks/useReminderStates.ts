import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { ReminderState } from "../../zero/schema.gen.ts";

// Settled for the purposes of "which row does the chip reflect": nothing more
// happens to these on their own. `escalated` is deliberately NOT here -- the
// row is still live for its recipient and still acks, and ReminderChip treats
// it as actionable. The two lists must agree or the chip offers an Ack on a row
// this hook has already passed over.
const SETTLED = new Set(["acked", "expired", "failed"]);

// reminder_state is per recipient and syncs own-user only, so this is already
// "my reminders" -- a co-assignee's escalation state is invisible here by
// construction (design 1).
export function useReminderStates(taskId?: string): {
	reminders: ReminderState[];
	// The row a status chip should reflect: the newest unsettled one, or the
	// newest row at all when every row is settled.
	current: ReminderState | null;
	loading: boolean;
} {
	const [rows, details] = useQuery(queries.reminderStates.mine());
	const reminders = useMemo(
		() =>
			taskId === undefined ? rows : rows.filter((r) => r.taskId === taskId),
		[rows, taskId],
	);
	// One pass, no copy and no sort: this runs once per rendered task row, so an
	// O(n log n) sort here turned a single reminder change into N full sorts.
	const current = useMemo(() => {
		let live: ReminderState | null = null;
		let newest: ReminderState | null = null;
		for (const row of reminders) {
			if (newest === null || row.occurrenceAt > newest.occurrenceAt) {
				newest = row;
			}
			if (SETTLED.has(row.status ?? "")) continue;
			if (live === null || row.occurrenceAt > live.occurrenceAt) live = row;
		}
		return live ?? newest;
	}, [reminders]);
	return { reminders, current, loading: details.type !== "complete" };
}
