import { useZero } from "@rocicorp/zero/react";
import { useState } from "react";
import { runMutation } from "@/lib/run-mutation";
import { cn } from "@/lib/utils";
import { mutators } from "../../../zero/mutators.ts";
import type { ReminderState, schema, Task } from "../../../zero/schema.gen.ts";
import { useReminderStates } from "../../hooks/useReminderStates.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";

const ACTIONABLE = new Set(["pending", "deferred", "escalated"]);

function hhmm(at: number): string {
	return new Date(at).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

// Text always states the status in words: the tone is never the sole signal
// (shell doc 8).
function label(
	reminder: ReminderState,
	resolvedMaxRepeats: number | null,
): { text: string; tone: string } {
	switch (reminder.status) {
		case "deferred":
			return {
				text: `Deferred until ${reminder.deferredUntil ? hhmm(reminder.deferredUntil) : "quiet hours end"}`,
				tone: "text-muted-foreground",
			};
		case "escalated":
			return {
				text: `Escalating (${reminder.fireCount} of ${resolvedMaxRepeats ?? "?"})`,
				tone: "text-amber-600",
			};
		case "acked":
			return { text: "Acknowledged", tone: "text-muted-foreground" };
		case "failed":
			return { text: "Reminder failed", tone: "text-destructive" };
		case "expired":
			return { text: "Reminder expired", tone: "text-destructive" };
		default:
			return {
				text: `Reminder set ${hhmm(reminder.occurrenceAt)}`,
				tone: "text-muted-foreground",
			};
	}
}

// The viewer's own reminder_state for this task, rendered as a chip next to the
// due indicator. While the reminder is still live the chip IS the in-app Ack
// control; terminal states are a static label (shell doc 5).
export function ReminderChip({ task }: { task: Task }) {
	const zero = useZero<typeof schema>();
	const { pref } = useUserPref();
	const { current } = useReminderStates(task.id);
	const [error, setError] = useState<string | null>(null);

	// Completion is the terminal state that matters: an acked chip on a done
	// task is noise.
	if (!current || (task.done && current.status === "acked")) return null;

	const resolved =
		task.maxRepeats ?? pref.escalationDefaults?.maxRepeats ?? null;
	const { text, tone } = label(current, resolved);
	const actionable = ACTIONABLE.has(current.status ?? "");

	if (!actionable) {
		return (
			<span
				data-testid="reminder-chip"
				className={cn("rounded-full border px-2 py-0.5 text-xs", tone)}
			>
				{text}
			</span>
		);
	}

	return (
		<>
			<button
				type="button"
				data-testid="reminder-chip"
				aria-label={`${text}. Acknowledge reminder`}
				// Row-level tap target parity with the habit done/skip controls.
				className={cn("min-h-9 rounded-full border px-3 py-0.5 text-xs", tone)}
				onClick={() => {
					setError(null);
					void runMutation(
						zero.mutate(mutators.reminder.ack({ id: current.id })),
						setError,
					);
				}}
			>
				{text} - Ack
			</button>
			{error && (
				<span role="alert" className="text-xs text-destructive">
					{error}
				</span>
			)}
		</>
	);
}
