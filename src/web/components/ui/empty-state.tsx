import type { LucideIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

// The house empty state: open space rather than a box, an optional quiet icon,
// a line, and at most one primary action passed as children. `title` is for
// surfaces that need a heading above the line; panels pass the line alone.
function EmptyState({
	icon: Icon,
	title,
	message,
	className,
	children,
	...props
}: React.ComponentProps<"div"> & {
	icon?: LucideIcon;
	title?: string;
	message: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center gap-4 px-6 py-12 text-center",
				className,
			)}
			{...props}
		>
			{Icon && <Icon aria-hidden className="size-6 text-muted-foreground" />}
			<div className="flex max-w-sm flex-col gap-1">
				{title && (
					<p className="text-base font-semibold text-balance">{title}</p>
				)}
				<p className="text-sm text-balance text-muted-foreground">{message}</p>
			</div>
			{children}
		</div>
	);
}

export { EmptyState };
