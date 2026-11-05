import { useQuery, useZero } from "@rocicorp/zero/react";
import { RotateCcw, UsersRound } from "lucide-react";
import { useId, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { checkShapeFor } from "@/lib/check-shape";
import { runMutation } from "@/lib/run-mutation";
import { cn } from "@/lib/utils";
import { localDay } from "../../../domain/local-day.ts";
import { DAILY_RRULE } from "../../../domain/recurrence.ts";
import { computeStreak, type HabitLogEntry } from "../../../domain/streak.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { List, schema, Task } from "../../../zero/schema.gen.ts";
import { useHabitLogs } from "../../hooks/useHabitLogs.ts";
import { useTaskImportActivation } from "../../hooks/useTaskImportActivation.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { ReminderChip } from "../task/ReminderChip.tsx";
import { HabitTracker } from "./HabitTracker.tsx";

type TodayStatus = "done" | "skipped" | "none";

export function HabitCard({
	task,
	list,
	onOpenDetail,
}: {
	task: Task;
	list: List;
	onOpenDetail: (task: Task) => void;
}) {
	const completionId = useId();
	const zero = useZero<typeof schema>();
	const activation = useTaskImportActivation(task.id);
	const activationId = `${completionId}-activation`;
	const reminderId = `${completionId}-reminder`;
	const { logs, loading: logsLoading } = useHabitLogs(task.id);
	const [workspaces, workspaceDetails] = useQuery(queries.workspaces.mine());
	const shared =
		workspaceDetails.type === "complete" &&
		workspaces.some(
			(row) => row.id === list.workspaceId && row.kind === "shared",
		);
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
			task.rrule
				? computeStreak(task.rrule, entries, today, 30, since, {
						anchorAt:
							task.recurrenceAnchorAt == null
								? null
								: new Date(
										`${localDay(new Date(task.recurrenceAnchorAt), pref.timezone)}T00:00:00Z`,
									),
						dueAt:
							task.dueAt == null
								? null
								: new Date(
										`${localDay(new Date(task.dueAt), pref.timezone)}T00:00:00Z`,
									),
						consumed: task.recurrenceConsumed ?? null,
						relative: task.recurrenceRelative ?? false,
						exhausted: task.done ?? false,
					})
				: null,
		[
			task.rrule,
			task.recurrenceAnchorAt,
			task.dueAt,
			task.recurrenceConsumed,
			task.recurrenceRelative,
			task.done,
			pref.timezone,
			entries,
			today,
			since,
		],
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
	const todayLog = logs.find((row) => row.date === today);
	const completer =
		!logsLoading &&
		done &&
		shared &&
		todayLog?.completedBy === todayLog?.completer?.id
			? todayLog?.completer?.name.trim()
			: null;

	const describedBy = [
		completer && completionId,
		(activation.status === "pending" || activation.status === "blocked") &&
			activationId,
		task.reminderTime && reminderId,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<div
			className="group/completion grid grid-cols-[2.75rem_minmax(0,1fr)_auto] items-start gap-x-1 py-2"
			data-testid="habit-card"
			data-kbd-row
			data-task-id={task.id}
		>
			<div className="flex min-h-11 items-center justify-center">
				<Checkbox
					ref={doneRef}
					shape={checkShapeFor("habits")}
					checked={done}
					aria-label={m.habit_complete_label({ title: task.title })}
					aria-describedby={describedBy}
					disabled={!activation.canWrite}
					data-testid="habit-done"
					data-kbd-action="toggle"
					className="after:-inset-x-3.5 after:-inset-y-3.5"
					onCheckedChange={(checked) => (checked ? log("done") : unlog())}
				/>
			</div>
			<button
				type="button"
				data-kbd-nav
				aria-label={task.title}
				aria-describedby={describedBy}
				data-task-id={task.id}
				onClick={() => onOpenDetail(task)}
				className="min-h-11 min-w-0 rounded py-0.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span
					className={cn(
						"block wrap-anywhere",
						done && "text-muted-foreground line-through",
					)}
					dir="auto"
				>
					{task.title}
				</span>
				<span className="flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
					{streak?.projectionStatus === "complete" && (
						<span data-testid="habit-streak">
							{m.habit_streak_label({
								days: m.habit_streak_days({ count: streak.current }),
							})}
						</span>
					)}
					{completer && (
						<span
							id={completionId}
							data-testid="completed-by"
							className="wrap-anywhere"
						>
							{m.task_completed_by({ name: `\u2068${completer}\u2069` })}
						</span>
					)}
					{task.reminderTime && (
						<span id={reminderId}>{task.reminderTime}</span>
					)}
					{(activation.status === "pending" ||
						activation.status === "blocked") && (
						<span id={activationId} className="text-warning">
							{activation.status === "pending"
								? m.activation_badge_pending()
								: m.activation_badge_blocked()}
						</span>
					)}
				</span>
			</button>
			<div className="flex items-center">
				<Button
					disabled={!activation.canWrite}
					type="button"
					variant="ghost"
					size="sm"
					aria-pressed={todayStatus === "skipped"}
					data-testid="habit-skip"
					onClick={() => log("skipped")}
					className="min-h-11 text-muted-foreground"
				>
					{m.habit_skip_action()}
				</Button>
				{todayStatus !== "none" && (
					<Button
						disabled={!activation.canWrite}
						type="button"
						variant="ghost"
						size="icon"
						aria-label={m.habit_undo_action()}
						data-testid="habit-undo"
						onClick={() => {
							unlog();
							doneRef.current?.focus();
						}}
						className="size-11 text-muted-foreground"
					>
						<RotateCcw aria-hidden />
					</Button>
				)}
				{shared && (
					<Popover>
						<PopoverTrigger
							aria-label={m.habit_shared_label()}
							className="flex size-11 items-center justify-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<UsersRound className="size-4" aria-hidden />
						</PopoverTrigger>
						<PopoverContent>{m.habit_shared_rule()}</PopoverContent>
					</Popover>
				)}
				<ReminderChip task={task} />
			</div>
			<div className="col-span-2 col-start-2 min-w-0">
				{streak ? (
					streak.projectionStatus === "complete" ? (
						<HabitTracker streak={streak} today={today} />
					) : (
						<button
							type="button"
							onClick={() => onOpenDetail(task)}
							className="min-h-11 rounded text-start text-xs text-muted-foreground underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							{streak.projectionStatus === "needs-start"
								? m.recurrence_projection_needs_start()
								: m.recurrence_projection_capped()}
						</button>
					)
				) : (
					<Button
						disabled={!activation.canWrite}
						type="button"
						variant="ghost"
						size="sm"
						data-testid="habit-track-daily"
						onClick={() => {
							trackDaily();
							doneRef.current?.focus();
						}}
						className="min-h-11"
					>
						{m.habit_track_daily()}
					</Button>
				)}
			</div>
		</div>
	);
}
