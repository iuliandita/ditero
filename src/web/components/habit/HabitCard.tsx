import { useZero } from "@rocicorp/zero/react";
import { Check, RotateCcw, SkipForward } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { ListIcon } from "@/lib/list-icon";
import { runMutation } from "@/lib/run-mutation";
import { todayISO } from "@/lib/today";
import { cn } from "@/lib/utils";
import { computeStreak, type HabitLogEntry } from "../../../domain/streak.ts";
import { mutators } from "../../../zero/mutators.ts";
import type { List, schema, Task } from "../../../zero/schema.gen.ts";
import { useHabitLogs } from "../../hooks/useHabitLogs.ts";
import { ReminderChip } from "../task/ReminderChip.tsx";
import { HabitTracker } from "./HabitTracker.tsx";

type TodayStatus = "done" | "skipped" | "none";

// One habit rendered as a vertical card (shell doc 2): title + reminder, streak
// + adherence + heatmap (HabitTracker), and a single large primary "done" control
// with a secondary skip/undo pair. Completion is per-occurrence via habit_log,
// not the task's done flag. Mutations go straight through Zero (mirrors
// RecurrenceEditor); today is resolved in the same UTC frame as the streak math.
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
	const { logs } = useHabitLogs(task.id);
	const today = todayISO();

	const entries = useMemo<HabitLogEntry[]>(
		() => logs.map((l) => ({ date: l.date, status: l.status })),
		[logs],
	);
	const todayStatus: TodayStatus =
		entries.find((e) => e.date === today)?.status ?? "none";

	// Guard: computeStreak parses the RRULE and throws on an empty/malformed rule,
	// so only run it for a habit that actually has a recurrence set.
	const streak = useMemo(
		() => (task.rrule ? computeStreak(task.rrule, entries, today) : null),
		[task.rrule, entries, today],
	);

	function log(status: "done" | "skipped") {
		void runMutation(
			zero.mutate(
				mutators.habit.log({ habitId: task.id, date: today, status }),
			),
			() => {},
		);
	}

	function unlog() {
		void runMutation(
			zero.mutate(mutators.habit.unlog({ habitId: task.id, date: today })),
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
					onClick={() => onOpenDetail(task)}
					className="min-w-0 flex-1 text-start"
				>
					<span className="block truncate font-medium">{task.title}</span>
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
				<p
					className="mt-3 text-sm text-muted-foreground"
					data-testid="habit-no-recurrence"
				>
					Set a recurrence to start tracking this habit.
				</p>
			)}

			{/* Secondary skip/undo on the start side; the large primary "done" toggle
			    sits at the end so it lands in the thumb-zone on < md (shell doc 2). */}
			<div className="mt-3 flex items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-pressed={todayStatus === "skipped"}
						data-testid="habit-skip"
						onClick={() => log("skipped")}
					>
						<SkipForward /> Skip
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={todayStatus === "none"}
						data-testid="habit-undo"
						onClick={unlog}
					>
						<RotateCcw /> Undo
					</Button>
				</div>
				<Button
					type="button"
					variant={done ? "default" : "outline"}
					aria-pressed={done}
					aria-label={done ? "Done today" : "Mark done for today"}
					data-testid="habit-done"
					onClick={() => (done ? unlog() : log("done"))}
					className={cn(
						"min-h-11 min-w-24 transition-colors motion-reduce:transition-none",
						done && "bg-success text-background hover:bg-success/90",
					)}
				>
					<Check /> {done ? "Done" : "Done today"}
				</Button>
			</div>
		</div>
	);
}
