import { useZero } from "@rocicorp/zero/react";
import { Check, Repeat, RotateCcw, SkipForward } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ListIcon } from "@/lib/list-icon";
import { runMutation } from "@/lib/run-mutation";
import { cn } from "@/lib/utils";
import { localDay } from "../../../domain/local-day.ts";
import { DAILY_RRULE } from "../../../domain/recurrence.ts";
import { computeStreak, type HabitLogEntry } from "../../../domain/streak.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import type { List, schema, Task } from "../../../zero/schema.gen.ts";
import { useHabitLogs } from "../../hooks/useHabitLogs.ts";
import { useTaskImportActivation } from "../../hooks/useTaskImportActivation.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { ReminderChip } from "../task/ReminderChip.tsx";
import { HabitTracker } from "./HabitTracker.tsx";

type TodayStatus = "done" | "skipped" | "none";

// One habit rendered as a vertical card (shell doc 2): title + reminder, streak
// + adherence + heatmap (HabitTracker), and a single large primary "done" control
// with a secondary skip/undo pair. Completion is per-occurrence via habit_log,
// not the task's done flag. Mutations go straight through Zero (mirrors
// RecurrenceEditor); today is the user's local day (localDay), the same day an
// ack writes.
export function HabitCard({
	task,
	list,
	onOpenDetail,
}: {
	task: Task;
	list: List;
	onOpenDetail: (task: Task) => void;
}) {
	const zero = useZero<typeof schema>();
	const activation = useTaskImportActivation(task.id);
	const { logs } = useHabitLogs(task.id);
	const { pref } = useUserPref();
	const today = localDay(new Date(), pref.timezone);
	const since =
		task.createdAt == null
			? today
			: localDay(new Date(task.createdAt), pref.timezone);
	// Undo and Track daily unmount once used; focus lands on Done, not the body.
	const doneRef = useRef<HTMLButtonElement>(null);

	const entries = useMemo<HabitLogEntry[]>(
		() => logs.map((l) => ({ date: l.date, status: l.status })),
		[logs],
	);
	const todayStatus: TodayStatus =
		entries.find((e) => e.date === today)?.status ?? "none";

	// Guard: computeStreak parses the RRULE and throws on an empty/malformed rule,
	// so only run it for a habit that actually has a recurrence set.
	const streak = useMemo(
		() =>
			task.rrule ? computeStreak(task.rrule, entries, today, 30, since) : null,
		[task.rrule, entries, today, since],
	);

	function log(status: "done" | "skipped") {
		if (!activation.canWrite) return;
		void runMutation(
			zero.mutate(
				mutators.habit.log({ habitId: task.id, date: today, status }),
			),
			() => {},
		);
	}

	function unlog() {
		if (!activation.canWrite) return;
		void runMutation(
			zero.mutate(mutators.habit.unlog({ habitId: task.id, date: today })),
			() => {},
		);
	}

	// A habit made before new habits started daily has no rule to track against.
	function trackDaily() {
		if (!activation.canWrite) return;
		void runMutation(
			zero.mutate(mutators.task.update({ id: task.id, rrule: DAILY_RRULE })),
			() => {},
		);
	}

	const done = todayStatus === "done";

	return (
		<div className="rounded-lg border p-3" data-testid="habit-card">
			<div className="flex items-start gap-2">
				<ListIcon
					icon={list.icon}
					kind="habits"
					title={task.title}
					className="mt-0.5"
				/>
				<button
					type="button"
					data-kbd-nav
					data-task-id={task.id}
					onClick={() => onOpenDetail(task)}
					className="min-w-0 flex-1 text-start"
				>
					<span className="block truncate font-medium">{task.title}</span>
					{(activation.status === "pending" ||
						activation.status === "blocked") && (
						<span className="block text-xs text-warning">
							{activation.status === "pending"
								? m.activation_badge_pending()
								: m.activation_badge_blocked()}
						</span>
					)}
					{task.reminderTime && (
						<span className="text-xs text-muted-foreground">
							{task.reminderTime}
						</span>
					)}
				</button>
				{/* Outside the title button: the chip is itself the Ack control
				    while the reminder is live. */}
				<ReminderChip task={task} />
			</div>

			{streak ? (
				<div className="mt-3">
					<HabitTracker streak={streak} />
				</div>
			) : (
				<Button
					disabled={!activation.canWrite}
					type="button"
					variant="outline"
					size="sm"
					data-testid="habit-track-daily"
					onClick={() => {
						trackDaily();
						doneRef.current?.focus();
					}}
					className="mt-3 min-h-11 md:min-h-7"
				>
					<Repeat /> {m.habit_track_daily()}
				</Button>
			)}

			{/* Secondary skip/undo on the start side; the large primary "done" toggle
			    sits at the end so it lands in the thumb-zone on < md (shell doc 2). */}
			<div className="mt-3 flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<Button
						disabled={!activation.canWrite}
						type="button"
						variant="ghost"
						size="sm"
						aria-pressed={todayStatus === "skipped"}
						data-testid="habit-skip"
						onClick={() => log("skipped")}
						className="min-h-11 md:min-h-7"
					>
						<SkipForward /> {m.habit_skip_action()}
					</Button>
					{/* Nothing to undo until today is logged, so it is absent, not a
					    disabled ghost that reads as enabled. */}
					{todayStatus !== "none" && (
						<Button
							disabled={!activation.canWrite}
							type="button"
							variant="ghost"
							size="sm"
							data-testid="habit-undo"
							onClick={() => {
								unlog();
								doneRef.current?.focus();
							}}
							className="min-h-11 md:min-h-7"
						>
							<RotateCcw /> {m.habit_undo_action()}
						</Button>
					)}
				</div>
				<Button
					ref={doneRef}
					disabled={!activation.canWrite}
					type="button"
					variant={done ? "default" : "outline"}
					// One label in both states: the pressed fill says whether today is
					// done, and the name never drifts from what is on the button.
					aria-pressed={done}
					data-testid="habit-done"
					onClick={() => (done ? unlog() : log("done"))}
					className={cn(
						"min-h-11 min-w-24 transition-colors motion-reduce:transition-none",
						done && "bg-success text-background hover:bg-success/90",
					)}
				>
					<Check /> {m.habit_done_action()}
				</Button>
			</div>
		</div>
	);
}
