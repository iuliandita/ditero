import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

// Collapsible "N completed" group used only in `hide` display mode. Sink/keep
// modes interleave completed rows inline and never render this.
export function CompletedSection({
	count,
	children,
}: {
	count: number;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	if (count === 0) return null;
	return (
		<div className="mt-4 border-t pt-2">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-sm text-muted-foreground hover:text-foreground"
			>
				<ChevronRight
					className={cn("size-4 transition-transform", open && "rotate-90")}
				/>
				{count} completed
			</button>
			{open && <div className="mt-1">{children}</div>}
		</div>
	);
}
