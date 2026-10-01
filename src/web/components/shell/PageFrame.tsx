import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// One box per surface: a page header and its content sit in the same
// container, so their start and end edges line up. `reading` caps the width at
// the list measure (task rows, forms); `wide` keeps the full pane for boards,
// tables, calendars and dashboards.
export function PageFrame({
	measure,
	className,
	children,
	...props
}: ComponentProps<"div"> & { measure: "reading" | "wide" }) {
	return (
		<div className="p-4 md:p-6">
			<div
				data-page-frame={measure}
				className={cn(
					"flex min-w-0 flex-col gap-6",
					measure === "reading" && "max-w-3xl",
					className,
				)}
				{...props}
			>
				{children}
			</div>
		</div>
	);
}
