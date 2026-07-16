import { Flame } from "lucide-react";
import { cn } from "@/lib/utils";
import type { StreakResult } from "../../../domain/streak.ts";

type HeatCell = StreakResult["heatmap"][number];

// Shape + color per status (never color alone, per shell doc 2): done fills,
// skipped is a dashed outline, missed a solid destructive outline, upcoming a
// faint dotted cell. Each cell is labeled with its date + status for a11y.
const CELL_STYLE: Record<HeatCell["status"], string> = {
	done: "bg-success border border-success",
	skipped: "border border-dashed border-muted-foreground/60 bg-transparent",
	missed: "border border-destructive/60 bg-destructive/10",
	none: "border border-dotted border-muted-foreground/30 bg-transparent",
};

const STATUS_LABEL: Record<HeatCell["status"], string> = {
	done: "done",
	skipped: "skipped",
	missed: "missed",
	none: "upcoming",
};

// Read-only streak + adherence + heatmap presentation for one habit. Pure: no
// mutation, no data fetching. The heatmap is never a tap target (shell doc 2).
export function HabitTracker({ streak }: { streak: StreakResult }) {
	const { current, adherencePct, heatmap } = streak;
	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-3 text-sm">
				<span className="inline-flex items-center gap-1 font-medium">
					<Flame className="size-4 text-success" aria-hidden />
					<span data-testid="habit-streak">
						{current} day{current === 1 ? "" : "s"}
					</span>
				</span>
				<span className="text-muted-foreground" data-testid="habit-adherence">
					{adherencePct}% on track
				</span>
			</div>
			{heatmap.length > 0 && (
				<div className="flex flex-wrap gap-1" data-testid="habit-heatmap">
					{heatmap.map((c) => (
						<span
							key={c.date}
							role="img"
							aria-label={`${c.date}: ${STATUS_LABEL[c.status]}`}
							title={`${c.date}: ${STATUS_LABEL[c.status]}`}
							className={cn("size-3 rounded-sm", CELL_STYLE[c.status])}
						/>
					))}
				</div>
			)}
		</div>
	);
}
