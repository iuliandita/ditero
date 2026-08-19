import type * as React from "react";

import { cn } from "@/lib/utils";

// `animate-pulse` already means "active" elsewhere (FocusTimer, keymap capture),
// so the muted block -- not the pulse -- carries the loading meaning here; the
// pulse is decoration and drops out under prefers-reduced-motion. aria-hidden
// because a placeholder has no content to announce: the surrounding region
// carries the role="status" label instead.
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="skeleton"
			aria-hidden="true"
			className={cn(
				"animate-pulse rounded-lg bg-muted motion-reduce:animate-none",
				className,
			)}
			{...props}
		/>
	);
}

export { Skeleton };
