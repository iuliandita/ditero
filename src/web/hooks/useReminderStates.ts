import { useQuery } from "@rocicorp/zero/react";
import { useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { ReminderState } from "../../zero/schema.gen.ts";

const TERMINAL = new Set(["acked", "expired", "failed", "escalated"]);

// reminder_state is per recipient and syncs own-user only, so this is already
// "my reminders" -- a co-assignee's escalation state is invisible here by
// construction (design 1).
export function useReminderStates(taskId?: string): {
	reminders: ReminderState[];
	// The row a status chip should reflect: the newest non-terminal one, or the
	// newest row at all when every row is terminal.
	current: ReminderState | null;
	loading: boolean;
} {
	const [rows, details] = useQuery(queries.reminderStates.mine());
	const reminders = useMemo(
		() =>
			taskId === undefined ? rows : rows.filter((r) => r.taskId === taskId),
		[rows, taskId],
	);
	const current = useMemo(() => {
		if (reminders.length === 0) return null;
		const byNewest = [...reminders].sort(
			(a, b) => b.occurrenceAt - a.occurrenceAt,
		);
		return byNewest.find((r) => !TERMINAL.has(r.status ?? "")) ?? byNewest[0];
	}, [reminders]);
	return { reminders, current, loading: details.type !== "complete" };
}
