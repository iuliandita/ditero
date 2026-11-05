import { cn } from "@/lib/utils";
import type { StreakResult } from "../../../domain/streak.ts";
import { m } from "../../../paraglide/messages.js";
import { formatDayKey } from "../../lib/intl-format.ts";

type HeatCell = StreakResult["heatmap"][number];

// Shape per status (never color alone, per shell doc 2): done fills, skipped is
// a dashed outline, missed a quiet solid outline, upcoming a faint dotted cell.
// A missed day is information, not an alarm, so it stays neutral. Each cell is
// labeled with its date + status for a11y.
const CELL_STYLE: Record<HeatCell["status"], string> = {
	done: "bg-primary border border-primary",
	skipped: "border border-dashed border-muted-foreground/60 bg-transparent",
	missed: "border border-control-border bg-muted",
	none: "border border-dotted border-muted-foreground/30 bg-transparent",
};

// Whole cell name per status, not a translated fragment concatenated onto the
// date. Thunks: module-scope locale freeze.
const CELL_LABEL: Record<HeatCell["status"], (date: string) => string> = {
	done: (date) => m.habit_heatmap_done({ date }),
	skipped: (date) => m.habit_heatmap_skipped({ date }),
	missed: (date) => m.habit_heatmap_missed({ date }),
	none: (date) => m.habit_heatmap_upcoming({ date }),
};

export function HabitTracker({
	streak,
	today,
}: {
	streak: StreakResult;
	today: string;
}) {
	const { heatmap } = streak;
	const first = heatmap[0];
	const last = heatmap.at(-1);
	if (!first || !last) return null;
	return (
		<div className="mt-1 flex max-w-sm flex-col gap-1.5 text-xs text-muted-foreground">
			<div
				className="grid gap-1"
				style={{
					gridTemplateColumns: `repeat(${heatmap.length}, minmax(0, 1fr))`,
					width: `min(100%, ${heatmap.length * 12 - 4}px)`,
				}}
				data-testid="habit-heatmap"
			>
				{heatmap.map((cell) => {
					const label = CELL_LABEL[cell.status](formatDayKey(cell.date));
					return (
						<span
							key={cell.date}
							role="img"
							aria-label={label}
							title={label}
							aria-current={cell.date === today ? "date" : undefined}
							className={cn(
								"aspect-square w-full max-w-2 rounded-full",
								CELL_STYLE[cell.status],
								cell.date === today &&
									"ring-1 ring-foreground ring-offset-2 ring-offset-background",
							)}
						/>
					);
				})}
			</div>
			<div
				className="flex flex-wrap items-center justify-between gap-x-2"
				data-testid="habit-history-range"
			>
				<span>
					{m.habit_history_range({
						first: formatDayKey(first.date),
						last: formatDayKey(last.date),
					})}
				</span>
				{last.date === today && (
					<span data-testid="habit-history-today">{m.due_today()}</span>
				)}
			</div>
		</div>
	);
}
