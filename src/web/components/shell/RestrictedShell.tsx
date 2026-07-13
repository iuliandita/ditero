import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { runMutation } from "@/lib/run-mutation";
import { formatDue, isOverdue } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { RestrictedTaskDetail } from "./RestrictedTaskDetail.tsx";

// A single large-touch-target row for the kid surface. Deliberately not TaskRow:
// no swipe/schedule/reorder/subtask affordances -- a kid completes and opens; the
// big tap target and generous height are the point.
function RestrictedRow({
	task,
	onToggle,
	onOpen,
}: {
	task: Task;
	onToggle: () => void;
	onOpen: () => void;
}) {
	return (
		<li
			data-testid="restricted-task"
			className="flex items-center gap-3 rounded-xl border p-4"
		>
			<Checkbox
				aria-label={task.title}
				checked={task.done ?? false}
				onCheckedChange={onToggle}
				className="size-6"
			/>
			<button
				type="button"
				onClick={onOpen}
				className="min-w-0 flex-1 text-start"
			>
				<span
					className={cn(
						"block truncate text-lg",
						task.done && "text-muted-foreground line-through",
					)}
				>
					{task.title}
				</span>
				{task.dueAt != null && (
					<span
						className={cn(
							"text-sm",
							isOverdue(task) ? "text-destructive" : "text-muted-foreground",
						)}
					>
						{formatDue(task.dueAt, task.dueAllDay)}
					</span>
				)}
			</button>
		</li>
	);
}

// Restricted ("kid") surface: a single cross-workspace "assigned to me" list.
// No sidebar, switcher, folders, create-list, FAB, members, or settings -- the
// kid completes and comments on assigned tasks and nothing else. Mounted by
// Workspace when the current user is a restricted managed account.
export function RestrictedShell() {
	const zero = useZero<typeof schema>();
	const [assignees] = useQuery(queries.assignees.mine());
	const [tasks] = useQuery(queries.tasks.mine());
	const [lists] = useQuery(queries.lists.mine());
	const [error, setError] = useState<string | null>(null);
	const [detailTaskId, setDetailTaskId] = useState<string | null>(null);

	const myTaskIds = useMemo(() => {
		const me = zero.userID ?? "";
		return new Set(
			assignees.filter((a) => a.userId === me).map((a) => a.taskId),
		);
	}, [assignees, zero.userID]);

	// Assigned tasks, open first then completed; each keeps its own list for the
	// detail sheet (assignments span workspaces).
	const myTasks = useMemo(() => {
		const rows = tasks.filter((t) => myTaskIds.has(t.id));
		return rows.sort((a, b) => {
			const ad = a.done ? 1 : 0;
			const bd = b.done ? 1 : 0;
			if (ad !== bd) return ad - bd;
			return a.sortKey < b.sortKey ? -1 : 1;
		});
	}, [tasks, myTaskIds]);

	const detailTask = detailTaskId
		? (myTasks.find((t) => t.id === detailTaskId) ?? null)
		: null;
	const detailList = detailTask
		? (lists.find((l) => l.id === detailTask.listId) ?? null)
		: null;

	function toggle(task: Task) {
		setError(null);
		void runMutation(
			zero.mutate(
				mutators.task.update({ id: task.id, done: !(task.done ?? false) }),
			),
			setError,
		);
	}

	return (
		<div data-testid="restricted-shell" className="min-h-dvh">
			<main className="mx-auto w-full max-w-xl p-4 md:p-6">
				<h1 className="mb-4 text-2xl font-semibold">My tasks</h1>

				{error && (
					<p role="alert" className="mb-2 text-sm text-destructive">
						{error}
					</p>
				)}

				{myTasks.length === 0 ? (
					<p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
						Nothing assigned to you right now.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{myTasks.map((task) => (
							<RestrictedRow
								key={task.id}
								task={task}
								onToggle={() => toggle(task)}
								onOpen={() => setDetailTaskId(task.id)}
							/>
						))}
					</ul>
				)}
			</main>

			{detailList && (
				<RestrictedTaskDetail
					task={detailTask}
					workspaceId={detailList.workspaceId}
					open={detailTaskId != null}
					onOpenChange={(o) => {
						if (!o) setDetailTaskId(null);
					}}
				/>
			)}
		</div>
	);
}
