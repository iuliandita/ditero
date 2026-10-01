import { ChevronRight } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";

// Collapsed-by-default group that completed rows settle into (sink and hide
// modes). Keep mode interleaves completed rows inline and never renders this.
export function CompletedSection({
	count,
	label,
	children,
}: {
	count: number;
	label: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const regionId = useId();
	if (count === 0) return null;
	return (
		<div className="mt-4 border-t pt-2">
			<button
				type="button"
				data-testid="completed-section"
				aria-expanded={open}
				aria-controls={regionId}
				onClick={() => setOpen((o) => !o)}
				className="flex min-h-11 w-full items-center gap-1.5 rounded-lg px-1 text-sm text-muted-foreground transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none md:min-h-9"
			>
				{/* Disclosure rule: closed mirrors in RTL, open points down. */}
				<ChevronRight
					aria-hidden
					className={cn(
						"size-4 transition-transform duration-(--motion-base) ease-(--motion-ease) motion-reduce:transition-none",
						open ? "rotate-90" : "rtl:rotate-180",
					)}
				/>
				{label}
			</button>
			<div id={regionId} hidden={!open} className="mt-1">
				{open && children}
			</div>
		</div>
	);
}
