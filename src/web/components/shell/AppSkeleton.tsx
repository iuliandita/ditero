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

// Mirrors the signed-in AppShell (single md breakpoint, auto_1fr grid, 280px
// sidebar, 56px phone header, three-tab bottom bar, 12px content padding scale)
// so real content replaces the silhouette in place instead of reflowing. Only
// rendered once a session exists; BootSkeleton covers the undecided state.
export function ShellSkeleton() {
	return (
		<div
			data-testid="shell-skeleton"
			role="status"
			aria-label={m.app_loading()}
			className="min-h-dvh md:grid md:grid-cols-[auto_1fr]"
		>
			<div className="hidden h-dvh w-[280px] flex-col gap-2 border-e bg-sidebar p-2 md:flex">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-8 w-full" />
				))}
				<Skeleton className="mt-5 h-10 w-full" />
				<div className="flex flex-col gap-2">
					{[0, 1, 2, 3, 4].map((i) => (
						<Skeleton key={i} className="h-7 w-full" />
					))}
				</div>
			</div>
			<div className="md:min-w-0">
				<div className="flex h-14 items-center gap-2 border-b ps-4 pe-2 md:hidden">
					<Skeleton className="h-6 w-32" />
					<div className="ms-auto flex size-11 items-center justify-center">
						<Skeleton className="size-5" />
					</div>
				</div>
				<main className="mx-auto w-full md:max-w-[1200px]">
					<div className="p-4 md:p-6">
						<div className="flex max-w-3xl flex-col gap-3">
							<Skeleton className="h-7 w-48" />
							<TaskRowsSkeleton />
						</div>
					</div>
				</main>
			</div>
			<div
				aria-hidden
				className="fixed inset-x-0 bottom-0 grid h-14 grid-cols-3 items-center justify-items-center border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
			>
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} className="h-9 w-12" />
				))}
			</div>
		</div>
	);
}

// Row silhouettes at TaskRow's 48px minimum height. Used by
// every task surface so a list and a view degrade to the same shape.
export function TaskRowsSkeleton({ rows = 5 }: { rows?: number }) {
	const keys = Array.from({ length: rows }, (_, i) => `skeleton-row-${i}`);
	return (
		<div className="flex flex-col gap-2">
			{keys.map((key) => (
				<div key={key} className="flex min-h-12 items-center gap-2">
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
