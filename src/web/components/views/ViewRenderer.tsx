import { useZero } from "@rocicorp/zero/react";
import { List as ListIcon } from "lucide-react";
import { type JSX, useMemo, useRef, useState } from "react";
import { runMutation } from "@/lib/run-mutation";
import { useIsDesktop } from "@/lib/use-media-query";
import type { ListKind } from "../../../domain/icon-map.ts";
import type {
	FilterCtx,
	FilterGroup,
	FilterTask,
	ViewDisplay,
} from "../../../domain/view-filter.ts";
import {
	resolveWorkspaceScope,
	taskMatchesFilter,
} from "../../../domain/view-filter.ts";
import { mutators } from "../../../zero/mutators.ts";
import type {
	Folder,
	Label,
	List,
	schema,
	Task,
	TaskAssignee,
	TaskLabel,
} from "../../../zero/schema.gen.ts";
import type { GroupCtx, GroupTask } from "../../views/group.ts";
import { groupTasks } from "../../views/group.ts";
import { SortableList } from "../list/SortableList.tsx";
import { type RowHandlers, TaskRow } from "../list/TaskRow.tsx";
import { BoardLayout } from "./BoardLayout.tsx";
import { TableLayout } from "./TableLayout.tsx";

// One filtered+enriched task ready to render as a row/card/cell.
export type ViewEntry = { task: Task; kind: ListKind; labels: Label[] };
export type ViewEntryGroup = {
	key: string;
	label: string;
	entries: ViewEntry[];
};
export type ViewSort = { field: string; dir: "asc" | "desc" };

type Enriched = {
	task: Task;
	kind: ListKind;
	labels: Label[];
	filterTask: FilterTask;
	groupTask: GroupTask;
};

// Base ascending comparators; `dir` flips the sign. Null due sorts last on asc.
function compareBy(a: Enriched, b: Enriched, field: string): number {
	switch (field) {
		case "due": {
			const av = a.task.dueAt ?? Number.POSITIVE_INFINITY;
			const bv = b.task.dueAt ?? Number.POSITIVE_INFINITY;
			return av - bv;
		}
		case "priority":
			return (a.task.priority ?? 0) - (b.task.priority ?? 0);
		case "title":
			return a.task.title.localeCompare(b.task.title);
		default:
			return a.task.sortKey < b.task.sortKey
				? -1
				: a.task.sortKey > b.task.sortKey
					? 1
					: 0;
	}
}

function sortEnriched(entries: Enriched[], sort: ViewSort): Enriched[] {
	const dir = sort.dir === "desc" ? -1 : 1;
	return [...entries].sort((a, b) => dir * compareBy(a, b, sort.field));
}

// group.ts skips empty priority buckets (correct for list/table), but a
// regroupable priority board needs every column present as a drop target. Pad
// to the fixed 4 in High->None order, reusing populated columns as-is. Board
// layer only; group.ts stays lean.
const PRIORITY_COLUMNS = [
	{ key: "3", label: "High" },
	{ key: "2", label: "Medium" },
	{ key: "1", label: "Low" },
	{ key: "0", label: "None" },
];
function padPriorityColumns(groups: ViewEntryGroup[]): ViewEntryGroup[] {
	const byKey = new Map(groups.map((g) => [g.key, g]));
	return PRIORITY_COLUMNS.map(
		(c) => byKey.get(c.key) ?? { key: c.key, label: c.label, entries: [] },
	);
}

export function ViewRenderer(props: {
	filter: FilterGroup;
	display: ViewDisplay;
	tasks: Task[];
	lists: List[];
	folders: Folder[];
	labels: Label[];
	taskLabels: TaskLabel[];
	assignees: TaskAssignee[];
	members: { id: string; name: string }[];
	currentUserId: string;
	membershipWorkspaceIds: string[];
	onOpenTask: (task: Task) => void;
	// Optional: Task 13 threads this to persist a table header sort into the
	// view row. Absent -> the header toggles a local, unpersisted sort.
	onSortChange?: (sort: ViewSort) => void;
}): JSX.Element {
	const {
		filter,
		display,
		tasks,
		lists,
		labels,
		taskLabels,
		assignees,
		members,
		currentUserId,
		membershipWorkspaceIds,
		onOpenTask,
		onSortChange,
	} = props;
	const zero = useZero<typeof schema>();
	const isDesktop = useIsDesktop();
	const [error, setError] = useState<string | null>(null);

	// Table header clicks drive the effective sort; seed from display.sort and
	// re-seed when the view (its display.sort object) changes.
	const [localSort, setLocalSort] = useState<ViewSort>(display.sort);
	const prevSortRef = useRef(display.sort);
	if (prevSortRef.current !== display.sort) {
		prevSortRef.current = display.sort;
		setLocalSort(display.sort);
	}

	const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists]);
	const labelById = useMemo(
		() => new Map(labels.map((l) => [l.id, l])),
		[labels],
	);
	const memberById = useMemo(
		() => new Map(members.map((m) => [m.id, m.name])),
		[members],
	);
	const labelIdsByTask = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const tl of taskLabels) {
			const bucket = map.get(tl.taskId);
			if (bucket) bucket.push(tl.labelId);
			else map.set(tl.taskId, [tl.labelId]);
		}
		return map;
	}, [taskLabels]);
	const assigneeIdsByTask = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const a of assignees) {
			const bucket = map.get(a.taskId);
			if (bucket) bucket.push(a.userId);
			else map.set(a.taskId, [a.userId]);
		}
		return map;
	}, [assignees]);

	// Enrich -> filter -> sort. Grouping is applied after (cheap, depends on the
	// resolved sort). Enrichment joins list (workspaceId/kind/folderId) and the
	// join tables (labelIds/assigneeIds) onto each task. `now` is derived inside
	// the memo (not a dep) so date buckets refresh when the data changes without
	// re-running on every render.
	const sorted = useMemo(() => {
		const ctx: FilterCtx = {
			userId: currentUserId,
			now: new Date(),
			membershipWorkspaceIds,
		};
		const scope = resolveWorkspaceScope(display.workspaceScope, ctx);
		const out: Enriched[] = [];
		for (const task of tasks) {
			const list = listById.get(task.listId);
			if (!list) continue;
			const labelIds = labelIdsByTask.get(task.id) ?? [];
			const assigneeIds = assigneeIdsByTask.get(task.id) ?? [];
			const dueAt = task.dueAt == null ? null : new Date(task.dueAt);
			const filterTask: FilterTask = {
				id: task.id,
				listId: task.listId,
				workspaceId: list.workspaceId,
				done: task.done ?? false,
				dueAt,
				priority: task.priority ?? 0,
				kind: list.kind ?? "tasks",
				folderId: list.folderId ?? null,
				labelIds,
				assigneeIds,
			};
			if (!scope.has(filterTask.workspaceId)) continue;
			if (!taskMatchesFilter(filterTask, filter, ctx)) continue;
			out.push({
				task,
				kind: (list.kind ?? "tasks") as ListKind,
				labels: labelIds
					.map((id) => labelById.get(id))
					.filter((l): l is Label => l != null),
				filterTask,
				groupTask: {
					id: task.id,
					listId: task.listId,
					title: task.title,
					done: task.done ?? false,
					dueAt,
					priority: task.priority ?? 0,
					assigneeIds,
					labelIds,
				},
			});
		}
		return sortEnriched(out, localSort);
	}, [
		tasks,
		listById,
		labelById,
		labelIdsByTask,
		assigneeIdsByTask,
		filter,
		display.workspaceScope,
		currentUserId,
		membershipWorkspaceIds,
		localSort,
	]);

	const entryGroups = useMemo<ViewEntryGroup[]>(() => {
		const groupCtx: GroupCtx = {
			now: new Date(),
			listTitle: (id) => listById.get(id)?.title ?? "List",
			memberName: (id) => memberById.get(id) ?? "Someone",
			labelName: (id) => labelById.get(id)?.name ?? "Label",
		};
		const byId = new Map(sorted.map((e) => [e.task.id, e]));
		const groups = groupTasks(
			sorted.map((e) => e.groupTask),
			display.groupBy,
			groupCtx,
		);
		return groups.map((g) => ({
			key: g.key,
			label: g.label,
			entries: g.tasks
				.map((t) => byId.get(t.id))
				.filter((e): e is Enriched => e != null),
		}));
	}, [sorted, display.groupBy, listById, labelById, memberById]);

	function run(mutation: { client: Promise<unknown> }) {
		setError(null);
		return runMutation(mutation, setError);
	}

	const handlers: RowHandlers = {
		onToggle: (id, done) =>
			void run(zero.mutate(mutators.task.update({ id, done: !done }))),
		onOpenDetail: (task) => onOpenTask(task),
	};

	function onReorder(id: string, sortKey: string) {
		void run(zero.mutate(mutators.task.update({ id, sortKey })));
	}

	// Board cross-column regroup only writes a single scalar, so it is safe for
	// priority (-> priority) and status (-> done); other group-bys are
	// reorder-only within a column.
	function onRegroup(id: string, columnKey: string) {
		if (display.groupBy === "priority") {
			void run(
				zero.mutate(mutators.task.update({ id, priority: Number(columnKey) })),
			);
		} else if (display.groupBy === "status") {
			void run(
				zero.mutate(mutators.task.update({ id, done: columnKey === "done" })),
			);
		}
	}

	function onSort(sort: ViewSort) {
		setLocalSort(sort);
		onSortChange?.(sort);
	}

	// Shared guard: a manual sortKey reorder only makes sense when the visible
	// order IS sortKey order ascending. Under any scalar sort the view re-sorts
	// after the write, so the dragged row snaps back and a stray sortKey is
	// persisted. List and board within-column reorder both use this predicate.
	const sortKeyOrdered =
		(localSort.field === "sortKey" || localSort.field === "") &&
		localSort.dir !== "desc";

	// Only the ungrouped list in sortKey order is drag-reorderable; every
	// grouped/other-sorted view renders static rows (M1a lesson).
	const listReorderable = display.groupBy === "none" && sortKeyOrdered;

	// Board within-column reorder is coherent for partitioning group-bys (each
	// task in one column) AND only when the sort is sortKey order; assignee/label
	// fan a task across columns, so those boards never reorder. Cross-column
	// regroup (priority/status) writes the grouped scalar, not sortKey, so it
	// stays enabled regardless of sort.
	const boardReorderable =
		display.groupBy !== "assignee" &&
		display.groupBy !== "label" &&
		sortKeyOrdered;
	const boardRegroupable =
		display.groupBy === "priority" || display.groupBy === "status";

	const asList = !isDesktop && display.layout !== "list";
	const renderList = display.layout === "list" || !isDesktop;

	return (
		<div data-testid="view-renderer">
			{error && (
				<p role="alert" className="mb-2 text-sm text-destructive">
					{error}
				</p>
			)}
			{asList && (
				<p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
					<ListIcon className="size-3.5" />
					Viewing as list
				</p>
			)}
			{renderList ? (
				<ListLayout
					groups={entryGroups}
					reorderable={listReorderable}
					handlers={handlers}
					onReorder={onReorder}
				/>
			) : display.layout === "board" ? (
				<BoardLayout
					groups={
						display.groupBy === "priority"
							? padPriorityColumns(entryGroups)
							: entryGroups
					}
					handlers={handlers}
					reorderable={boardReorderable}
					regroupable={boardRegroupable}
					onReorder={onReorder}
					onRegroup={onRegroup}
				/>
			) : (
				<TableLayout
					entries={sorted.map((e) => ({ task: e.task, labels: e.labels }))}
					sort={localSort}
					onSort={onSort}
					listTitle={(id) => listById.get(id)?.title ?? "List"}
					onOpenTask={onOpenTask}
				/>
			)}
		</div>
	);
}

function ListLayout({
	groups,
	reorderable,
	handlers,
	onReorder,
}: {
	groups: ViewEntryGroup[];
	reorderable: boolean;
	handlers: RowHandlers;
	onReorder: (id: string, sortKey: string) => void;
}) {
	const renderRow = (entry: ViewEntry) => (
		<TaskRow
			task={entry.task}
			kind={entry.kind}
			subtasks={[]}
			labels={entry.labels}
			handlers={handlers}
		/>
	);

	return (
		<div className="flex flex-col gap-4">
			{groups.map((g) => (
				<section key={g.key || "all"} aria-label={g.label || undefined}>
					{g.label && (
						<h3 className="mb-1 flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
							{g.label}
							<span aria-hidden="true">{g.entries.length}</span>
						</h3>
					)}
					{reorderable ? (
						<SortableList
							items={g.entries.map((e) => ({
								id: e.task.id,
								sortKey: e.task.sortKey,
								entry: e,
							}))}
							onMove={onReorder}
							renderItem={(item) => renderRow(item.entry)}
							handleLabel="Reorder task"
							handleTestId="view-reorder"
						/>
					) : (
						<ul className="flex flex-col">
							{g.entries.map((e) => (
								<li key={e.task.id}>{renderRow(e)}</li>
							))}
						</ul>
					)}
				</section>
			))}
		</div>
	);
}
