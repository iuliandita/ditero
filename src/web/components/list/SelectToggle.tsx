import { Check } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";

// Bulk selection for one row. `active` means the list is in selection mode:
// the done control steps aside, this control leads the row, and clicking the
// row toggles it instead of opening the task.
export type RowSelection = {
	selected: boolean;
	active: boolean;
	selectable: boolean;
	/** Why a row cannot be selected (an import paused it). */
	blockedReason?: string;
	toggle: () => void;
	extend: () => void;
};

// The select control, a pressed-state button with a square mark in the item
// checkbox style. It takes the done checkbox's slot, and only in selection mode;
// outside it a row offers Select from its menu, a long-press or a modifier click.
export function SelectToggle({
	title,
	selection,
}: {
	title: string;
	selection: RowSelection;
}) {
	const reasonId = useId();
	const blocked = !selection.selectable;
	return (
		<button
			type="button"
			aria-pressed={selection.selected}
			aria-label={m.task_select_aria({ title })}
			aria-disabled={blocked || undefined}
			aria-describedby={
				blocked && selection.blockedReason ? reasonId : undefined
			}
			title={blocked ? selection.blockedReason : undefined}
			data-testid="task-select"
			data-placement="lead"
			onClick={(event) => {
				event.stopPropagation();
				if (event.shiftKey) selection.extend();
				else selection.toggle();
			}}
			className={cn(
				"flex size-(--row-slot) shrink-0 items-center justify-center rounded-md duration-(--motion-fast) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90",
				blocked && "cursor-not-allowed",
			)}
		>
			<span
				aria-hidden
				className={cn(
					"flex size-[18px] items-center justify-center rounded-[5px] border-[1.5px] transition-colors duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none",
					selection.selected
						? "border-primary bg-primary text-primary-foreground"
						: blocked
							? "border-dashed border-control-border/60"
							: "border-control-border",
				)}
			>
				{selection.selected && <Check className="size-3.5" strokeWidth={3} />}
			</span>
			{blocked && selection.blockedReason && (
				<span id={reasonId} className="sr-only">
					{selection.blockedReason}
				</span>
			)}
		</button>
	);
}
