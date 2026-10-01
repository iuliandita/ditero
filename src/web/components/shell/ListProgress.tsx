import { useId } from "react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";

// Aggregate completion bar for project-kind lists: compact in the index surfaces
// (sidebar tree + mobile list-of-lists), with a visible count in the list header.
// Renders nothing when the list has no tasks. done/total counts come from the
// already-synced tasks.mine data.
export function ListProgress({
	done,
	total,
	showLabel = false,
	className,
}: {
	done: number;
	total: number;
	showLabel?: boolean;
	className?: string;
}) {
	const labelId = useId();
	if (total === 0) return null;
	const pct = Math.round((done / total) * 100);
	const label = m.list_progress_label({ done, total });
	const bar = (
		<div
			className={cn(
				"h-1 w-full overflow-hidden rounded-full bg-muted",
				!showLabel && "mt-1",
			)}
			role="progressbar"
			aria-valuenow={pct}
			aria-valuemin={0}
			aria-valuemax={100}
			{...(showLabel
				? { "aria-labelledby": labelId }
				: { "aria-label": label, title: label })}
		>
			<div
				className="h-full rounded-full bg-kind-project"
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
	if (!showLabel) return bar;
	return (
		<div
			className={cn("flex items-center gap-3", className)}
			data-testid="list-progress"
		>
			<span
				id={labelId}
				className="shrink-0 text-xs text-muted-foreground tabular-nums"
			>
				{label}
			</span>
			<div className="max-w-48 flex-1">{bar}</div>
		</div>
	);
}
