import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

// The house empty-state frame (first used by DashboardView): dashed card, one
// muted icon, a muted line, an optional CTA. `title` is for surfaces that need
// a heading above the line; panels pass the line alone.
function EmptyState({
	icon: Icon,
	title,
	message,
	className,
	children,
	...props
}: React.ComponentProps<"div"> & {
	icon: LucideIcon;
	title?: string;
	message: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center gap-3 rounded-lg border border-dashed p-10 text-center",
				className,
			)}
			{...props}
		>
			<Icon aria-hidden className="size-8 text-muted-foreground" />
			<div className="flex flex-col gap-1">
				{title && <p className="text-sm font-medium">{title}</p>}
				<p className="text-sm text-muted-foreground">{message}</p>
			</div>
			{children}
		</div>
	);
}

export { EmptyState };
