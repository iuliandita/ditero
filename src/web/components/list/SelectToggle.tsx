import { Check } from "lucide-react";
import { useId } from "react";
import { TOUCH_KEYBOARD_ONLY } from "@/lib/touch";
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
// checkbox style. `lead` takes the done checkbox's slot in selection mode;
// `trail` is the quiet way in outside it, revealed by hover or focus on a
// pointer and left out of the layout on touch, where long-press offers Select.
export function SelectToggle({
	title,
	selection,
	placement,
}: {
	title: string;
	selection: RowSelection;
	placement: "lead" | "trail";
}) {
	const reasonId = useId();
	const blocked = !selection.selectable;
	const lead = placement === "lead";
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
			data-placement={placement}
			onClick={(event) => {
				event.stopPropagation();
				if (event.shiftKey) selection.extend();
				else selection.toggle();
			}}
			className={cn(
				"flex shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
				lead
					? "size-11 md:size-8 duration-(--motion-fast) motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90"
					: [
							"size-11 md:size-7",
							"md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 focus-visible:opacity-100",
							TOUCH_KEYBOARD_ONLY,
						],
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
