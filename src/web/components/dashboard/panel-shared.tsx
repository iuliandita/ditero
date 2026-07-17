import { useZero } from "@rocicorp/zero/react";
import { type JSX, useMemo, useState } from "react";
import { runMutation } from "@/lib/run-mutation";
import type { ResolvedSource } from "../../../domain/dashboard.ts";
import type { ListKind } from "../../../domain/icon-map.ts";
import { mutators } from "../../../zero/mutators.ts";
import type {
	Label,
	List,
	schema,
	Task,
	TaskAssignee,
	TaskLabel,
} from "../../../zero/schema.gen.ts";
import { type RowHandlers, TaskRow } from "../list/TaskRow.tsx";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog.tsx";
import { matchingTasks, type PanelEntry } from "./panel-tasks.ts";

// Shared row inputs for tasks/counter panels (same synced sets ViewRenderer
// consumes); DashboardView memoizes one instance for all panels.
export type PanelData = {
	tasks: Task[];
	lists: List[];
	labels: Label[];
	taskLabels: TaskLabel[];
	assignees: TaskAssignee[];
};
export type PanelIds = {
	currentUserId: string;
	membershipWorkspaceIds: string[];
};

export type TaskEntry = PanelEntry<Task, Label>;

export function usePanelEntries(
	data: PanelData,
	resolved: ResolvedSource,
	ids: PanelIds,
): TaskEntry[] {
	const { tasks, lists, labels, taskLabels, assignees } = data;
	// `now` derives inside the memo (not a dep) so relative-date buckets refresh
	// when the data changes without re-running on every render (M1c pattern).
	return useMemo(
		() =>
			matchingTasks({ tasks, lists, labels, taskLabels, assignees }, resolved, {
				userId: ids.currentUserId,
				now: new Date(),
				membershipWorkspaceIds: ids.membershipWorkspaceIds,
			}),
		[
			tasks,
			lists,
			labels,
			taskLabels,
			assignees,
			resolved,
			ids.currentUserId,
			ids.membershipWorkspaceIds,
		],
	);
}

// Row completion goes through task.complete (recurrence advance + Karma; the
// server rejects habit-kind tasks) exactly like ViewRenderer; un-checking a
// done row is a plain task.update revert. NEVER task.update({done: true}).
export function usePanelRowHandlers(onOpenTask: (task: Task) => void): {
	handlers: RowHandlers;
	error: string | null;
} {
	const zero = useZero<typeof schema>();
	const [error, setError] = useState<string | null>(null);
	const handlers = useMemo<RowHandlers>(
		() => ({
			onToggle: (id, done) => {
				setError(null);
				void runMutation(
					zero.mutate(
						done
							? mutators.task.update({ id, done: false })
							: mutators.task.complete({ id }),
					),
					setError,
				);
			},
			onOpenDetail: onOpenTask,
		}),
		[zero, onOpenTask],
	);
	return { handlers, error };
}

export function PanelTaskList({
	entries,
	handlers,
}: {
	entries: TaskEntry[];
	handlers: RowHandlers;
}): JSX.Element {
	return (
		<ul className="flex flex-col">
			{entries.map((e) => (
				<li key={e.task.id}>
					<TaskRow
						task={e.task}
						kind={e.kind as ListKind}
						subtasks={[]}
						labels={e.labels}
						handlers={handlers}
					/>
				</li>
			))}
		</ul>
	);
}

// Inline-source "Show all" / counter click-through target: the full matching
// set in a plain modal (a view-ref source opens its view instead).
export function PanelExpandDialog({
	open,
	onOpenChange,
	label,
	entries,
	handlers,
	error,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	label: string;
	entries: TaskEntry[];
	handlers: RowHandlers;
	error: string | null;
}): JSX.Element {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85dvh] max-w-lg flex-col gap-0 p-0">
				<DialogHeader className="p-4 pb-2 md:px-6">
					<DialogTitle>
						{label} ({entries.length})
					</DialogTitle>
				</DialogHeader>
				<div className="overflow-y-auto px-4 pb-4 md:px-6">
					{error && (
						<p role="alert" className="mb-2 text-sm text-destructive">
							{error}
						</p>
					)}
					<PanelTaskList entries={entries} handlers={handlers} />
				</div>
			</DialogContent>
		</Dialog>
	);
}
