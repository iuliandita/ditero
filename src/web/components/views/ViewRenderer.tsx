import { useQuery, useZero } from "@rocicorp/zero/react";
import { List as ListIcon, SearchX } from "lucide-react";
import { type JSX, type ReactNode, useMemo, useRef, useState } from "react";
import { runMutation } from "@/lib/run-mutation";
import { useWideContent } from "@/lib/use-wide-content";
import type { ListKind } from "../../../domain/icon-map.ts";
import { type Role, WRITE_ROLES } from "../../../domain/role.ts";
import { compareTasksBy } from "../../../domain/task-sort.ts";
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
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type {
	Folder,
	Label,
	List,
	schema,
	Task,
	TaskAssignee,
	TaskLabel,
} from "../../../zero/schema.gen.ts";
import { useRowSelection } from "../../hooks/useRowSelection.ts";
import { useTaskImportActivationMap } from "../../hooks/useTaskImportActivation.ts";
import { useTaskToggle } from "../../hooks/useTaskToggle.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";
import type { GroupCtx, GroupTask } from "../../views/group.ts";
import {
	effectiveGroupBy,
	filterMentionsDone,
	groupForView,
} from "../../views/group.ts";
import { BulkSelection } from "../list/BulkSelection.tsx";
import { SortableList } from "../list/SortableList.tsx";
import {
	type RowHandlers,
	type RowSelection,
	TaskRow,
} from "../list/TaskRow.tsx";
import { TaskListSkeleton } from "../shell/AppSkeleton.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { BoardLayout } from "./BoardLayout.tsx";
import { CalendarLayout } from "./CalendarLayout.tsx";
import { TableLayout } from "./TableLayout.tsx";

// One filtered+enriched task ready to render as a row/card/cell.
export type ViewEntry = {
	task: Task;
	kind: ListKind;
	labels: Label[];
	listTitle: string;
	listIcon: string | null;
};
export type ViewEntryGroup = {
	key: string;
	label: string;
	entries: ViewEntry[];
};
export type ViewSort = { field: string; dir: "asc" | "desc" };

type Enriched = ViewEntry & {
	filterTask: FilterTask;
	groupTask: GroupTask;
};

function sortEnriched(entries: Enriched[], sort: ViewSort): Enriched[] {
	const dir = sort.dir === "desc" ? -1 : 1;
	return [...entries].sort(
		(a, b) => dir * compareTasksBy(a.task, b.task, sort.field),
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
	// Zero result completeness for the row sets above, resolved by the caller
	// that owns the queries. Without it an unsynced surface is indistinguishable
	// from an empty one and neither state can be rendered.
	loading?: boolean;
	// Optional: Task 13 threads this to persist a table header sort into the
	// view row. Absent -> the header toggles a local, unpersisted sort.
	onSortChange?: (sort: ViewSort) => void;
	// The first-run welcome's actions; only the landing supplies them.
	firstRun?: ReactNode;
}): JSX.Element {
	const { pref } = useUserPref();
	const activation = useTaskImportActivationMap();
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
		loading = false,
	} = props;
	const zero = useZero<typeof schema>();
	// Width the view actually gets, not the viewport (the docked detail).
	const [measureRef, isDesktop] = useWideContent();
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
		() => new Map(members.map((member) => [member.id, member.name])),
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
				listTitle: list.title || m.list_untitled_fallback(),
				listIcon: list.icon ?? null,
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
			listTitle: (id) => listById.get(id)?.title ?? m.list_untitled_fallback(),
			memberName: (id) => memberById.get(id) ?? m.group_unknown_user(),
			labelName: (id) => labelById.get(id)?.name ?? m.group_unknown_label(),
		};
		const byId = new Map(sorted.map((e) => [e.task.id, e]));
		const groups = groupForView(
			sorted.map((e) => e.groupTask),
			display.layout,
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
	}, [
		sorted,
		display.layout,
		display.groupBy,
		listById,
		labelById,
		memberById,
	]);

	function run(mutation: { client: Promise<unknown> }) {
		setError(null);
		return runMutation(mutation, setError);
	}
	const toggleTask = useTaskToggle(run);

	// Bulk selection on the list layout. A view spans workspaces, so each row is
	// eligible by the caller's write role where it lives; habits complete per
	// occurrence and never join. An eligible row an import paused shows why it
	// cannot be picked.
	const [memberships] = useQuery(queries.memberships.mine());
	const writableWorkspaces = useMemo(
		() =>
			new Set(
				memberships
					.filter((mem) => mem.userId === currentUserId)
					.filter((mem) => WRITE_ROLES.has(mem.role as Role))
					.map((mem) => mem.workspaceId),
			),
		[memberships, currentUserId],
	);
	const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
	const eligible = (task: Task): boolean => {
		const list = listById.get(task.listId);
		return (
			list != null &&
			list.kind !== "habits" &&
			writableWorkspaces.has(list.workspaceId)
		);
	};
	const selection = useRowSelection({
		enabled: renderListFor(display.layout, isDesktop) && !loading,
		resetKey: `${display.layout}:${JSON.stringify(filter)}`,
		isSelectable: (id) => {
			const task = taskById.get(id);
			return (
				task != null &&
				eligible(task) &&
				activation.canWriteTask(id) &&
				tasks.every((t) => t.parentId !== id || activation.canWriteTask(t.id))
			);
		},
	});
	const selectionFor = (task: Task): RowSelection | undefined =>
		eligible(task)
			? selection.rowFor(task.id, m.selection_paused_reason())
			: undefined;
	const selectedTasks = (): Task[] =>
		selection
			.ordered()
			.map((id) => taskById.get(id))
			.filter((t): t is Task => t != null);
	// Move only within one workspace, the same rule as the task detail's move.
	const bulkMoveTargets = (selected: Task[]): List[] => {
		const workspaces = new Set(
			selected.map((t) => listById.get(t.listId)?.workspaceId),
		);
		if (workspaces.size !== 1) return [];
		const [workspaceId] = workspaces;
		return lists.filter(
			(l) =>
				l.workspaceId === workspaceId &&
				l.kind !== "habits" &&
				!selected.every((t) => t.listId === l.id),
		);
	};

	const handlers: RowHandlers = {
		onToggle: (id) => {
			const task = tasks.find((t) => t.id === id);
			if (task && activation.canWriteTask(id)) toggleTask(task);
		},
		onOpenDetail: (task) => onOpenTask(task),
	};

	function onReorder(id: string, sortKey: string) {
		if (!activation.canWriteTask(id)) return;
		void run(zero.mutate(mutators.task.update({ id, sortKey })));
	}

	const groupBy = effectiveGroupBy(display.layout, display.groupBy);

	// Board cross-column regroup only writes a single scalar, so it is safe for
	// priority (-> priority) and status (-> done); other group-bys are
	// reorder-only within a column.
	function onRegroup(id: string, columnKey: string) {
		if (!activation.canWriteTask(id)) return;
		if (groupBy === "priority") {
			void run(
				zero.mutate(mutators.task.update({ id, priority: Number(columnKey) })),
			);
		} else if (groupBy === "status") {
			void run(
				zero.mutate(
					columnKey === "done"
						? mutators.task.complete({ id })
						: mutators.task.update({ id, done: false }),
				),
			);
		}
	}

	function onSort(sort: ViewSort) {
		setLocalSort(sort);
		onSortChange?.(sort);
	}

	function onReschedule(id: string, dueAt: number) {
		if (!activation.canWriteTask(id)) return;
		void run(zero.mutate(mutators.task.update({ id, dueAt })));
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
	const listReorderable = groupBy === "none" && sortKeyOrdered;

	// Board within-column reorder is coherent for partitioning group-bys (each
	// task in one column) AND only when the sort is sortKey order; assignee/label
	// fan a task across columns, so those boards never reorder. Cross-column
	// regroup (priority/status) writes the grouped scalar, not sortKey, so it
	// stays enabled regardless of sort.
	const boardReorderable =
		groupBy !== "assignee" && groupBy !== "label" && sortKeyOrdered;
	const boardRegroupable = groupBy === "priority" || groupBy === "status";
	// A status board's Done column is the completed group, so it never folds.
	const collapseCompleted = !filterMentionsDone(filter) && groupBy !== "status";
	const spansLists = new Set(sorted.map((e) => e.task.listId)).size > 1;

	// Calendar owns its own mobile collapse (month grid -> agenda), so it is not
	// folded into the generic "viewing as list" path.
	const asList =
		!isDesktop && display.layout !== "list" && display.layout !== "calendar";
	const renderList = renderListFor(display.layout, isDesktop);
	const selected = selection.count > 0 ? selectedTasks() : [];

	// Only the row path. A board's columns (also the regroup drop targets), a
	// table's headers and the calendar's month grid are each still an answer when
	// nothing matches; replacing them with a card would remove the affordance.
	const empty = sorted.length === 0 && renderList;

	return (
		<div ref={measureRef} data-testid="view-renderer">
			{error && (
				<p role="alert" className="mb-2 text-sm text-destructive">
					{error}
				</p>
			)}
			{asList && !loading && sorted.length > 0 && (
				<p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
					<ListIcon className="size-3.5" />
					{m.view_viewing_as_list()}
				</p>
			)}
			{loading ? (
				<TaskListSkeleton />
			) : empty ? (
				// A user with no list in any workspace is new and gets onboarded; once
				// one exists, even empty, an empty view is simply a filter that matched
				// nothing. Same frame, different job.
				lists.length === 0 ? (
					<EmptyState
						data-testid="view-empty-first-use"
						title={m.view_empty_welcome_title()}
						message={m.view_empty_welcome_hint()}
					>
						{props.firstRun}
					</EmptyState>
				) : (
					<EmptyState
						data-testid="view-empty-no-match"
						icon={SearchX}
						message={m.view_empty_no_match()}
					/>
				)
			) : display.layout === "calendar" ? (
				<CalendarLayout
					entries={sorted}
					isDesktop={isDesktop}
					onOpenTask={onOpenTask}
					onReschedule={onReschedule}
					canDrag={activation.canWriteTask}
					timeZone={pref.timezone}
				/>
			) : renderList ? (
				<div ref={selection.rootRef}>
					<BulkSelection
						count={selection.count}
						selected={selected}
						variant="tasks"
						moveTargets={bulkMoveTargets(selected)}
						allTasks={tasks}
						showDueAndPriority={selected.some((t) => {
							const kind = listById.get(t.listId)?.kind;
							return kind !== "checklist" && kind !== "shopping";
						})}
						run={run}
						onDone={selection.finish}
					/>
					<ListLayout
						// A board pads empty priority columns as drop targets; as a list
						// they would only be empty headings.
						groups={
							display.layout === "board"
								? entryGroups.filter((g) => g.entries.length > 0)
								: entryGroups
						}
						reorderable={listReorderable}
						handlers={handlers}
						onReorder={onReorder}
						canDrag={activation.canWriteTask}
						selectionFor={selectionFor}
					/>
				</div>
			) : display.layout === "board" ? (
				<BoardLayout
					groups={entryGroups}
					handlers={handlers}
					priorityColumns={groupBy === "priority"}
					collapseCompleted={collapseCompleted}
					spansLists={spansLists}
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
					listTitle={(id) =>
						listById.get(id)?.title ?? m.list_untitled_fallback()
					}
					onOpenTask={onOpenTask}
				/>
			)}
		</div>
	);
}

// Calendar owns its own mobile collapse (month grid -> agenda), so it is not
// folded into the generic "viewing as list" path.
function renderListFor(layout: ViewDisplay["layout"], isDesktop: boolean) {
	return layout === "list" || (!isDesktop && layout !== "calendar");
}

function ListLayout({
	groups,
	reorderable,
	handlers,
	onReorder,
	canDrag,
	selectionFor,
}: {
	groups: ViewEntryGroup[];
	reorderable: boolean;
	handlers: RowHandlers;
	onReorder: (id: string, sortKey: string) => void;
	canDrag: (id: string) => boolean;
	selectionFor: (task: Task) => RowSelection | undefined;
}) {
	const renderRow = (entry: ViewEntry) => (
		<TaskRow
			task={entry.task}
			kind={entry.kind}
			subtasks={[]}
			labels={entry.labels}
			handlers={handlers}
			selection={selectionFor(entry.task)}
		/>
	);

	return (
		// Reading measure: only the vertical row path. Board scrolls columns and
		// calendar is a 7-column grid, so both keep the full content width.
		<div className="flex max-w-3xl flex-col gap-4">
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
							canDrag={canDrag}
							renderItem={(item) => renderRow(item.entry)}
							handleLabel={m.task_reorder_handle()}
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
