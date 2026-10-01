import { useQuery, useZero } from "@rocicorp/zero/react";
import { useId, useMemo, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { checkShapeFor, checkToneFor } from "@/lib/check-shape";
import { runMutation } from "@/lib/run-mutation";
import { formatDue, isOverdue } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import {
	useTaskImportActivation,
	useTaskImportActivationMap,
} from "../../hooks/useTaskImportActivation.ts";
import { CompletedBy } from "../list/CompletedBy.tsx";
import { DisplaySettings } from "../settings/DisplaySettings.tsx";
import { RestrictedTaskDetail } from "./RestrictedTaskDetail.tsx";
import { SyncIndicator } from "./SyncIndicator.tsx";

// A single large-touch-target row for the kid surface. Deliberately not TaskRow:
// no swipe/schedule/reorder/subtask affordances -- a kid completes and opens; the
// big tap target and generous height are the point.
function RestrictedRow({
	task,
	kind,
	onToggle,
	onOpen,
}: {
	task: Task;
	kind: ListKind;
	onToggle: () => void;
	onOpen: () => void;
}) {
	const completionId = useId();
	const activation = useTaskImportActivation(task.id);
	const activationId = `${completionId}-activation`;
	const dueId = `${completionId}-due`;
	const describedBy = [
		completionId,
		(activation.status === "pending" || activation.status === "blocked") &&
			activationId,
		task.dueAt != null && dueId,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<li
			data-testid="restricted-task"
			className="group/completion flex items-center gap-3 rounded-xl border p-4"
		>
			<Checkbox
				disabled={!activation.canWrite}
				aria-label={task.title}
				aria-describedby={completionId}
				checked={task.done ?? false}
				onCheckedChange={onToggle}
				shape={checkShapeFor(kind)}
				priority={checkToneFor(kind, task.priority)}
				className="size-6"
			/>
			<button
				type="button"
				aria-label={task.title}
				aria-describedby={describedBy}
				onClick={onOpen}
				className="min-w-0 flex-1 text-start"
			>
				<span
					className={cn(
						"block text-lg [overflow-wrap:anywhere]",
						task.done && "text-muted-foreground line-through",
					)}
				>
					{task.title}
				</span>
				<CompletedBy task={task} id={completionId} />
				{(activation.status === "pending" ||
					activation.status === "blocked") && (
					<span id={activationId} className="block text-xs text-warning">
						{activation.status === "pending"
							? m.activation_badge_pending()
							: m.activation_badge_blocked()}
					</span>
				)}
				{task.dueAt != null && (
					<span
						id={dueId}
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
// No sidebar, switcher, folders, create-list, FAB, members, or account settings -- the
// kid completes and comments on assigned tasks and nothing else. Mounted by
// Workspace when the current user is a restricted managed account.
export function RestrictedShell() {
	const zero = useZero<typeof schema>();
	const activation = useTaskImportActivationMap();
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
		if (!activation.canWriteTask(task.id)) return;
		setError(null);
		const done = task.done ?? false;
		void runMutation(
			zero.mutate(
				done
					? mutators.task.update({ id: task.id, done: false })
					: mutators.task.complete({ id: task.id }),
			),
			setError,
		);
	}

	return (
		<div data-testid="restricted-shell" className="min-h-dvh">
			<main className="mx-auto w-full max-w-xl p-4 md:p-6">
				<div className="mb-4 flex items-center gap-2">
					<h1 className="min-w-0 flex-1 text-2xl font-semibold">
						{m.restricted_my_tasks_heading()}
					</h1>
					<SyncIndicator placement="header" />
				</div>
				<details className="mb-4 rounded-lg border p-3">
					<summary className="min-h-11 cursor-pointer content-center text-sm font-medium">
						{m.display_settings_label()}
					</summary>
					<div className="pt-4">
						<DisplaySettings />
					</div>
				</details>

				{error && (
					<p role="alert" className="mb-2 text-sm text-destructive">
						{error}
					</p>
				)}

				{myTasks.length === 0 ? (
					<p className="rounded-xl border border-dashed p-6 text-center text-muted-foreground">
						{m.restricted_nothing_assigned()}
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{myTasks.map((task) => (
							<RestrictedRow
								key={task.id}
								task={task}
								kind={
									(lists.find((l) => l.id === task.listId)?.kind ??
										"tasks") as ListKind
								}
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
