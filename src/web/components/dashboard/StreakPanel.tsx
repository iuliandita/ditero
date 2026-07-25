import { Flame } from "lucide-react";
import { type JSX, useMemo } from "react";
import type { Panel } from "../../../domain/dashboard.ts";
import { localDay } from "../../../domain/local-day.ts";
import { computeStreak, type HabitLogEntry } from "../../../domain/streak.ts";
import { m } from "../../../paraglide/messages.js";
import type { Task } from "../../../zero/schema.gen.ts";
import { useHabitLogs } from "../../hooks/useHabitLogs.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import type { PanelData } from "./panel-shared.tsx";

// One picked habit as a compact row: title + current streak + adherence (no
// heatmap; that stays on HabitCard). Streak math is the same domain call
// HabitCard makes, over the same synced habit_log rows and local-day frame.
function StreakRow({
	task,
	onOpenTask,
}: {
	task: Task;
	onOpenTask: (task: Task) => void;
}): JSX.Element {
	const { logs } = useHabitLogs(task.id);
	const { pref } = useUserPref();
	const today = localDay(new Date(), pref.timezone);
	const entries = useMemo<HabitLogEntry[]>(
		() => logs.map((l) => ({ date: l.date, status: l.status })),
		[logs],
	);
	// computeStreak throws on an empty/malformed rule; only run with one set.
	const streak = useMemo(
		() => (task.rrule ? computeStreak(task.rrule, entries, today) : null),
		[task.rrule, entries, today],
	);

	const summary = streak
		? m.panel_streak_summary({
				count: streak.current,
				pct: streak.adherencePct,
			})
		: m.panel_streak_no_recurrence_summary();
	return (
		<button
			type="button"
			data-testid="streak-row"
			aria-label={m.panel_streak_row_aria({ title: task.title, summary })}
			onClick={() => onOpenTask(task)}
			className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-start hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
		>
			<span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
			{streak ? (
				<>
					<span className="inline-flex items-center gap-1 text-sm font-medium tabular-nums">
						<Flame aria-hidden className="size-3.5 text-success" />
						{streak.current}
					</span>
					<span className="text-xs text-muted-foreground tabular-nums">
						{streak.adherencePct}%
					</span>
				</>
			) : (
				<span className="text-xs text-muted-foreground">
					{m.panel_streak_no_recurrence()}
				</span>
			)}
		</button>
	);
}

// Compact strip of the picked habits. A habitId that no longer resolves to a
// synced habit-kind task (deleted, or its list left the caller's sync set)
// renders an explicit muted "missing" row, never silently drops.
export function StreakPanel({
	panel,
	data,
	onOpenTask,
}: {
	panel: Extract<Panel, { type: "streak" }>;
	data: PanelData;
	onOpenTask: (task: Task) => void;
}): JSX.Element {
	const habitById = useMemo(() => {
		const listKind = new Map(data.lists.map((l) => [l.id, l.kind ?? "tasks"]));
		const map = new Map<string, Task>();
		for (const t of data.tasks) {
			if (listKind.get(t.listId) === "habits") map.set(t.id, t);
		}
		return map;
	}, [data.tasks, data.lists]);

	return (
		<ul data-testid="streak-panel" className="flex flex-col">
			{panel.habitIds.map((id) => {
				const task = habitById.get(id);
				return (
					<li key={id}>
						{task ? (
							<StreakRow task={task} onOpenTask={onOpenTask} />
						) : (
							<p
								data-testid="streak-missing"
								className="px-1 py-1.5 text-sm text-muted-foreground"
							>
								{m.panel_streak_missing()}
							</p>
						)}
					</li>
				);
			})}
		</ul>
	);
}
