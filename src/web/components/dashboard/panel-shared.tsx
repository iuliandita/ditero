import { useZero } from "@rocicorp/zero/react";
import { Flag } from "lucide-react";
import { type JSX, useMemo, useState } from "react";
import { runMutation } from "@/lib/run-mutation";
import { priorityLabel, priorityMeta } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import type { ResolvedSource } from "../../../domain/dashboard.ts";
import type { ListKind } from "../../../domain/icon-map.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import type {
	Label,
	List,
	schema,
	Task,
	TaskAssignee,
	TaskLabel,
} from "../../../zero/schema.gen.ts";
import { useTaskImportActivationMap } from "../../hooks/useTaskImportActivation.ts";
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
	const activation = useTaskImportActivationMap();
	const [error, setError] = useState<string | null>(null);
	const handlers = useMemo<RowHandlers>(
		() => ({
			onToggle: (id, done) => {
				if (!activation.canWriteTask(id)) return;
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
		[zero, onOpenTask, activation],
	);
	return { handlers, error };
}

// How a panel lays out its rows: whether to label each row with its list
// (the set spans lists) and whether to section rows by priority (the source
// view groups by it).
export type PanelRowOptions = {
	listOf: ((listId: string) => { title: string; icon: string | null }) | null;
	byPriority: boolean;
};

const PLAIN_ROWS: PanelRowOptions = { listOf: null, byPriority: false };

const PRIORITY_SECTIONS = [3, 2, 1, 0];
const priorityLevel = (t: Task) =>
	PRIORITY_SECTIONS.includes(t.priority ?? 0) ? (t.priority ?? 0) : 0;

// Stable: rows keep the source sort inside each priority, and a cap then keeps
// the most urgent rows rather than whichever the sort put first.
export function orderForPanel(
	entries: TaskEntry[],
	byPriority: boolean,
): TaskEntry[] {
	if (!byPriority) return entries;
	return [...entries].sort(
		(a, b) => priorityLevel(b.task) - priorityLevel(a.task),
	);
}

function PanelRows({
	entries,
	handlers,
	listOf,
	surface,
}: {
	entries: TaskEntry[];
	handlers: RowHandlers;
	listOf: PanelRowOptions["listOf"];
	surface: "card" | "popover";
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
						surface={surface}
						list={listOf ? listOf(e.task.listId) : null}
					/>
				</li>
			))}
		</ul>
	);
}

export function PanelTaskList({
	entries,
	handlers,
	options,
	surface = "card",
}: {
	entries: TaskEntry[];
	handlers: RowHandlers;
	options: PanelRowOptions;
	surface?: "card" | "popover";
}): JSX.Element {
	if (!options.byPriority)
		return (
			<PanelRows
				entries={entries}
				handlers={handlers}
				listOf={options.listOf}
				surface={surface}
			/>
		);
	return (
		<div className="flex flex-col gap-3">
			{PRIORITY_SECTIONS.map((p) => {
				const rows = entries.filter((e) => priorityLevel(e.task) === p);
				if (rows.length === 0) return null;
				const tone = priorityMeta(p);
				return (
					<section
						key={p}
						aria-label={priorityLabel(p)}
						data-testid="panel-priority-section"
					>
						<h3 className="mb-1 flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground">
							{tone && (
								<Flag
									aria-hidden
									className={cn("size-3.5 shrink-0 fill-current", tone.color)}
								/>
							)}
							{priorityLabel(p)}
							<span aria-hidden="true">{rows.length}</span>
						</h3>
						<PanelRows
							entries={rows}
							handlers={handlers}
							listOf={options.listOf}
							surface={surface}
						/>
					</section>
				);
			})}
		</div>
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
	options = PLAIN_ROWS,
	error,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	label: string;
	entries: TaskEntry[];
	handlers: RowHandlers;
	options?: PanelRowOptions;
	error: string | null;
}): JSX.Element {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-lg">
				<DialogHeader className="p-4 pb-2 md:px-6">
					<DialogTitle>
						{m.panel_expand_title({ label, count: entries.length })}
					</DialogTitle>
				</DialogHeader>
				<div className="overflow-y-auto px-4 pb-4 md:px-6">
					{error && (
						<p role="alert" className="mb-2 text-sm text-destructive">
							{error}
						</p>
					)}
					<PanelTaskList
						entries={entries}
						handlers={handlers}
						options={options}
						surface="popover"
					/>
				</div>
			</DialogContent>
		</Dialog>
	);
}
