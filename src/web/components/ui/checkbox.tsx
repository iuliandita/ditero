import { cva } from "class-variance-authority";
import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

// Round marks a task someone does; square marks an item ticked off a list
// (shopping, checklist) and every form choice. A priority tone colors the ring
// and the done fill so priority reads at the point of completion, not only on
// the flag at the end of the row.
const checkboxVariants = cva(
	"peer group/checkbox relative flex shrink-0 items-center justify-center border border-control-border bg-transparent transition-[background-color,border-color,color,box-shadow] duration-(--motion-fast) ease-(--motion-ease) outline-none motion-reduce:transition-none group-has-disabled/field:opacity-50 after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/40",
	{
		variants: {
			shape: {
				square: "size-4 rounded-[4px]",
				round: "size-[18px] rounded-full border-[1.5px]",
			},
			tone: {
				none: "text-muted-foreground data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground",
				1: "border-priority-1 bg-priority-1/8 text-priority-1 data-checked:bg-priority-1 data-checked:text-background",
				2: "border-priority-2 bg-priority-2/8 text-priority-2 data-checked:bg-priority-2 data-checked:text-background",
				3: "border-priority-3 bg-priority-3/8 text-priority-3 data-checked:bg-priority-3 data-checked:text-background",
			},
		},
		defaultVariants: { shape: "square", tone: "none" },
	},
);

type Tone = "none" | 1 | 2 | 3;

function toneFor(priority: number | null | undefined): Tone {
	return priority === 1 || priority === 2 || priority === 3 ? priority : "none";
}

function Checkbox({
	className,
	shape = "square",
	priority,
	...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
	shape?: "square" | "round";
	/** Task priority 0-3; 0 or absent keeps the neutral ring. */
	priority?: number | null;
}) {
	const round = shape === "round";
	return (
		<CheckboxPrimitive.Root
			data-slot="checkbox"
			data-shape={shape}
			data-tone={toneFor(priority)}
			className={cn(
				checkboxVariants({ shape, tone: toneFor(priority) }),
				className,
			)}
			{...props}
		>
			{round && (
				// Hover preview of the check, the way a task invites completion.
				<CheckIcon
					data-slot="checkbox-preview"
					aria-hidden
					strokeWidth={3}
					className="pointer-events-none absolute size-2.5 opacity-0 transition-opacity duration-(--motion-fast) group-hover/checkbox:opacity-60 group-disabled/checkbox:hidden group-data-[state=checked]/checkbox:hidden motion-reduce:transition-none"
				/>
			)}
			<CheckboxPrimitive.Indicator
				data-slot="checkbox-indicator"
				className={cn(
					// No mount animation: the indicator also mounts on first render and when
					// the completed group opens; CHECK_POP animates real completions only.
					"grid place-content-center text-current",
					round ? "[&>svg]:size-2.5" : "[&>svg]:size-3.5",
				)}
			>
				<CheckIcon aria-hidden strokeWidth={round ? 3 : 2} />
			</CheckboxPrimitive.Indicator>
		</CheckboxPrimitive.Root>
	);
}

export { Checkbox };
