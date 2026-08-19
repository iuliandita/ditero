import { m } from "../../../paraglide/messages.js";
import { Skeleton } from "../ui/skeleton.tsx";

// Session resolution has not decided between Login and the workspace yet, so a
// sidebar silhouette here would flash the wrong layout at logged-out visitors.
// Neutral centered card instead -- it matches Login's own footprint.
export function BootSkeleton() {
	return (
		<div
			data-testid="boot-skeleton"
			role="status"
			aria-label={m.app_loading()}
			className="flex min-h-dvh items-center justify-center p-6"
		>
			<div className="flex w-full max-w-sm flex-col gap-3">
				<Skeleton className="h-7 w-32" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-9 w-24" />
			</div>
		</div>
	);
}

// Mirrors AppShell's frame (single md breakpoint, auto_1fr grid, 280px sidebar)
// so real content replaces the silhouette in place instead of reflowing.
export function ShellSkeleton() {
	return (
		<div
			data-testid="shell-skeleton"
			role="status"
			aria-label={m.app_loading()}
			className="min-h-dvh md:grid md:grid-cols-[auto_1fr]"
		>
			<div className="hidden h-dvh w-[280px] flex-col gap-2 border-e bg-sidebar p-2 md:flex">
				<Skeleton className="h-8 w-full" />
				<Skeleton className="h-8 w-full" />
				<div className="mt-4 flex flex-col gap-2">
					{[0, 1, 2, 3, 4].map((i) => (
						<Skeleton key={i} className="h-7 w-full" />
					))}
				</div>
			</div>
			<main className="p-4 md:p-6">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-4 md:max-w-[1200px]">
					<Skeleton className="h-7 w-48" />
					<TaskRowsSkeleton />
				</div>
			</main>
		</div>
	);
}

// Row silhouettes at TaskRow's height (py-1.5 around a min-h-9 row). Used by
// every task surface so a list and a view degrade to the same shape.
export function TaskRowsSkeleton({ rows = 5 }: { rows?: number }) {
	const keys = Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`);
	return (
		<div className="flex flex-col gap-2">
			{keys.map((key) => (
				<div key={key} className="flex items-center gap-2 py-1.5">
					<Skeleton className="size-5 shrink-0 rounded-md" />
					<Skeleton className="h-5 flex-1" />
				</div>
			))}
		</div>
	);
}

// Standalone task-surface placeholder: the rows plus the live-region label the
// shell skeletons get from their own wrapper.
export function TaskListSkeleton({ rows = 5 }: { rows?: number }) {
	return (
		<div
			data-testid="task-list-skeleton"
			role="status"
			aria-label={m.tasks_loading()}
		>
			<TaskRowsSkeleton rows={rows} />
		</div>
	);
}
