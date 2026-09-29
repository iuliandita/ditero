import { useQuery, useZero } from "@rocicorp/zero/react";
import { ListTodo, Paperclip, SlidersHorizontal } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { addCopyFor } from "@/lib/kind-copy";
import { ListIcon } from "@/lib/list-icon";
import { runMutation } from "@/lib/run-mutation";
import { useIsDesktop, useMediaQuery } from "@/lib/use-media-query";
import type { ListKind } from "../../domain/icon-map.ts";
import { randomId } from "../../domain/random-id.ts";
import { WRITE_ROLES } from "../../domain/role.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import type { CompletedDisplay } from "../../domain/task-sort.ts";
import { snapshotList } from "../../domain/template.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { Label, List, schema, Task } from "../../zero/schema.gen.ts";
import {
	AttachmentList,
	type AttachmentListHandle,
} from "../components/attachments/AttachmentList.tsx";
import { IconPicker } from "../components/list/IconPicker.tsx";
import { ScheduleSheet } from "../components/list/ScheduleSheet.tsx";
import { TaskDetail } from "../components/list/TaskDetail.tsx";
import { TaskList } from "../components/list/TaskList.tsx";
import { TitleSuggestInput } from "../components/list/TitleSuggestInput.tsx";
import { TaskListSkeleton } from "../components/shell/AppSkeleton.tsx";
import { ListProgress } from "../components/shell/ListProgress.tsx";
import { BackButton } from "../components/ui/back-button.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";
import type { RowAction } from "../components/ui/row-action.ts";
import { RowActions } from "../components/ui/row-actions.tsx";
import { useTaskImportActivationMap } from "../hooks/useTaskImportActivation.ts";
import { useTaskToggle } from "../hooks/useTaskToggle.ts";

// `hide` stays a stored value but renders exactly like sink since #348 (both
// collapse completed rows into a group), so the menu offers only the two
// distinct behaviours and shows a hide list as sink.
const DISPLAY_MODES = ["sink", "keep"] as const;

// Thunks: resolving `m` at module scope would freeze the import-time locale.
const DISPLAY_MODE_LABELS: Record<
	(typeof DISPLAY_MODES)[number],
	() => string
> = {
	sink: m.list_completed_sink,
	keep: m.list_completed_keep,
};

function lastKey(items: { sortKey: string }[]): string | null {
	return items.reduce<string | null>(
		(max, i) => (max == null || i.sortKey > max ? i.sortKey : max),
		null,
	);
}

export function ListView({
	listId,
	listActions,
	onBack,
	onQuickAdd,
}: {
	listId: string;
	listActions: (list: List) => RowAction[];
	onBack?: () => void;
	onQuickAdd: () => void;
}) {
	const zero = useZero<typeof schema>();
	const activation = useTaskImportActivationMap();
	const [tasks, tasksDetails] = useQuery(queries.tasks.mine());
	const [lists, listsDetails] = useQuery(queries.lists.mine());
	const [labels] = useQuery(queries.labels.mine());
	const [taskLabels] = useQuery(queries.taskLabels.mine());
	const [assignees] = useQuery(queries.assignees.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const [templates] = useQuery(queries.templates.mine());
	const [title, setTitle] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [iconOpen, setIconOpen] = useState(false);
	const [groupByAssignee, setGroupByAssignee] = useState(false);
	const [reordering, setReordering] = useState(false);
	const isDesktop = useIsDesktop();
	const coarse = useMediaQuery("(pointer: coarse)");
	const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
	const [scheduleTaskId, setScheduleTaskId] = useState<string | null>(null);
	const titleInput = useRef<HTMLInputElement>(null);
	const attachmentsRef = useRef<AttachmentListHandle>(null);
	const listHeaderRef = useRef<HTMLDivElement>(null);

	// Zero reports per-query completeness; "no rows yet" and "no rows" are only
	// distinguishable here, where the queries live. The row surface below is pure.
	const listsLoading = listsDetails.type !== "complete";
	const tasksLoading = listsLoading || tasksDetails.type !== "complete";

	const list = lists.find((l) => l.id === listId);
	const listTasks = useMemo(
		() => tasks.filter((t) => t.listId === listId),
		[tasks, listId],
	);
	const parents = useMemo(
		() => listTasks.filter((t) => t.parentId == null),
		[listTasks],
	);

	// Suggestion pool: every task title already synced to this client. Subtasks
	// are excluded -- they are steps inside one task, not items a user re-adds.
	const titleCandidates = useMemo(
		() =>
			tasks
				.filter((t) => t.parentId == null)
				.map((t) => ({ title: t.title, listId: t.listId })),
		[tasks],
	);
	const subtasksByParent = useMemo(() => {
		const map = new Map<string, typeof listTasks>();
		for (const t of listTasks) {
			if (t.parentId == null) continue;
			const bucket = map.get(t.parentId);
			if (bucket) bucket.push(t);
			else map.set(t.parentId, [t]);
		}
		for (const bucket of map.values())
			bucket.sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
		return map;
	}, [listTasks]);

	const labelsById = useMemo(
		() => new Map<string, Label>(labels.map((l) => [l.id, l])),
		[labels],
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
	const labelsByTask = useMemo(() => {
		const map = new Map<string, Label[]>();
		for (const [taskId, ids] of labelIdsByTask) {
			const resolved = ids
				.map((id) => labelsById.get(id))
				.filter((l): l is Label => l != null);
			if (resolved.length) map.set(taskId, resolved);
		}
		return map;
	}, [labelIdsByTask, labelsById]);

	const userNames = useMemo(() => {
		const map = new Map<string, string>();
		for (const m of memberships) {
			if (m.user && !map.has(m.userId)) map.set(m.userId, m.user.name);
		}
		return map;
	}, [memberships]);

	// Client-only grouping over assignees.mine + parents. Each task lands in ONE
	// group by a primary assignee (me first, else the lexicographically-first
	// assignee), so a multi-assignee task is never double-listed. Order: "Assigned
	// to me", then a group per other assignee (by name), then "Unassigned".
	const assigneeGroups = useMemo(() => {
		const me = zero.userID ?? "";
		const byTask = new Map<string, string[]>();
		for (const a of assignees) {
			const bucket = byTask.get(a.taskId);
			if (bucket) bucket.push(a.userId);
			else byTask.set(a.taskId, [a.userId]);
		}
		const buckets = new Map<string, Task[]>();
		for (const p of parents) {
			const ids = byTask.get(p.id);
			let key = "";
			if (ids && ids.length > 0) {
				key = ids.includes(me) ? me : ([...ids].sort()[0] ?? "");
			}
			const bucket = buckets.get(key);
			if (bucket) bucket.push(p);
			else buckets.set(key, [p]);
		}
		const others = [...buckets.keys()].filter((k) => k !== me && k !== "");
		others.sort((a, b) =>
			(userNames.get(a) ?? a).localeCompare(userNames.get(b) ?? b),
		);
		const order = [me, ...others, ""].filter((k) => buckets.has(k));
		return order.map((key) => ({
			key,
			label:
				key === me
					? m.group_assigned_to_me()
					: key === ""
						? m.group_unassigned()
						: (userNames.get(key) ?? m.group_unknown_user()),
			tasks: buckets.get(key) ?? [],
		}));
	}, [assignees, parents, userNames, zero.userID]);

	const detailTask = detailTaskId
		? (listTasks.find((t) => t.id === detailTaskId) ?? null)
		: null;
	const scheduleTask = scheduleTaskId
		? (listTasks.find((t) => t.id === scheduleTaskId) ?? null)
		: null;

	function run(mutation: { client: Promise<unknown> }) {
		setError(null);
		return runMutation(mutation, setError);
	}
	const toggleTask = useTaskToggle(run);

	async function createTask() {
		const t = title.trim();
		if (!t) return;
		setTitle("");
		await run(
			zero.mutate(
				mutators.task.create({
					id: randomId(),
					listId,
					title: t,
					sortKey: keyBetween(lastKey(parents), null),
				}),
			),
		);
	}

	const backControl = onBack ? (
		<BackButton aria-label={m.list_back_to_lists()} onClick={onBack} />
	) : null;
	// A list id from a stale nav ref stays blank once lists have synced; before
	// that the id is simply not loaded yet. Mobile keeps its way back in both states.
	if (!list) {
		const content = listsLoading ? <TaskListSkeleton /> : null;
		if (!backControl) return content;
		return (
			<div className="max-w-3xl">
				<div className="mb-4 flex items-center">{backControl}</div>
				{content}
			</div>
		);
	}
	// Narrowed alias so nested function declarations keep the non-null type.
	const openList = list;
	const taskTemplates = templates.filter(
		(t) => t.kind === "task" && t.workspaceId === openList.workspaceId,
	);
	const kind = (list.kind ?? "tasks") as ListKind;
	const addCopy = addCopyFor(kind);
	// Same count as the sidebar bar: every task in the list, subtasks included.
	const doneCount = listTasks.filter((t) => t.done).length;
	const canEditContainer =
		!tasksLoading &&
		listTasks.every((task) => activation.canWriteTask(task.id));
	const mode = (list.completedDisplay ?? "sink") as CompletedDisplay;
	const callerRole = memberships.find(
		(member) =>
			member.workspaceId === openList.workspaceId &&
			member.userId === zero.userID,
	)?.role;
	const canAttach = callerRole != null && WRITE_ROLES.has(callerRole);
	// Touch drags from a grip that only exists in this mode; a pointer keeps the
	// hover grip and the keyboard reorders from a focused grip either way.
	const canReorder =
		coarse &&
		!groupByAssignee &&
		kind !== "shopping" &&
		kind !== "habits" &&
		parents.length > 1;
	const reorderActive = reordering && canReorder;
	const rowActions: RowAction[] = [
		...listActions(openList),
		{
			id: "attachment-add",
			label: m.attachment_add(),
			icon: Paperclip,
			hidden: !canAttach,
			onSelect: () => attachmentsRef.current?.openPicker(),
		},
	];

	const handlers = {
		onToggle: (id: string) => {
			const task = listTasks.find((t) => t.id === id);
			if (task && activation.canWriteTask(id)) toggleTask(task);
		},
		onOpenDetail: (task: { id: string }) => setDetailTaskId(task.id),
		onSchedule: (task: { id: string }) => {
			if (activation.canWriteTask(task.id)) setScheduleTaskId(task.id);
		},
		onMove: (id: string, sortKey: string) => {
			if (activation.canWriteTask(id))
				void run(zero.mutate(mutators.task.update({ id, sortKey })));
		},
		onUpdate: (id: string, patch: { quantity?: string; unit?: string }) => {
			if (activation.canWriteTask(id))
				void run(zero.mutate(mutators.task.update({ id, ...patch })));
		},
	};

	// Snapshot the current list (with one level of subtasks) into a reusable
	// workspace template; it then appears in the create-list template picker.
	function saveAsTemplate() {
		const rows = parents.map((p) => ({
			...p,
			subtasks: subtasksByParent.get(p.id) ?? [],
		}));
		const content = snapshotList({ kind, icon: openList.icon }, rows);
		void run(
			zero.mutate(
				mutators.template.save({
					id: randomId(),
					workspaceId: openList.workspaceId,
					name: openList.title,
					kind: "list",
					content,
					...(openList.icon != null ? { icon: openList.icon } : {}),
				}),
			),
		);
	}

	// Expand a saved task template into this list. The mirror of CreateList's
	// list-template picker: applied from the surface that owns the target
	// container, which for a task is the open list.
	function addFromTemplate(templateId: string) {
		void run(
			zero.mutate(
				mutators.template.instantiateTask({
					templateId,
					taskId: randomId(),
					listId,
					sortKey: keyBetween(lastKey(parents), null),
				}),
			),
		);
	}

	// One field, placed per shell: above the rows on desktop, after them on a
	// phone, where the thumb already is and the floating add button sits.
	const addForm = (
		<div className={isDesktop ? "mb-5 flex gap-2" : "mt-2 flex gap-2"}>
			<TitleSuggestInput
				inputRef={titleInput}
				data-testid="new-task"
				placeholder={addCopy.placeholder()}
				value={title}
				onChange={setTitle}
				onSubmit={() => void createTask()}
				candidates={titleCandidates}
				listId={listId}
			/>
			<Button
				data-testid="new-task-submit"
				type="button"
				className="min-h-11 md:min-h-0"
				onClick={() => void createTask()}
			>
				{addCopy.action()}
			</Button>
		</div>
	);
	const mobileAdd = isDesktop ? undefined : addForm;

	return (
		<div data-testid="list" className="max-w-3xl">
			{/* `group` is what RowActions' md:group-hover reveal keys off. */}
			<div ref={listHeaderRef} className="group mb-5 flex items-center gap-1.5">
				{backControl}
				<button
					type="button"
					disabled={!canEditContainer}
					aria-label={m.list_change_icon()}
					onClick={() => setIconOpen(true)}
					className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:size-9"
				>
					<ListIcon icon={list.icon} kind={kind} title={list.title} />
				</button>
				<h1 className="min-w-0 flex-1 truncate text-xl font-semibold md:text-2xl">
					{list.title}
				</h1>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={m.list_display_options()}
							className="size-11 md:size-8"
						>
							<SlidersHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel>{m.list_completed_heading()}</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={mode === "hide" ? "sink" : mode}
							onValueChange={(v) => {
								if (!canEditContainer) {
									setError(m.activation_container_paused());
									return;
								}
								void run(
									zero.mutate(
										mutators.list.update({
											id: list.id,
											completedDisplay: v as CompletedDisplay,
										}),
									),
								);
							}}
						>
							{DISPLAY_MODES.map((value) => (
								<DropdownMenuRadioItem
									key={value}
									value={value}
									disabled={!canEditContainer}
								>
									{DISPLAY_MODE_LABELS[value]()}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
						<DropdownMenuSeparator />
						<DropdownMenuCheckboxItem
							data-testid="group-by-assignee"
							checked={groupByAssignee}
							onCheckedChange={setGroupByAssignee}
							onSelect={(e) => e.preventDefault()}
						>
							{m.list_group_by_assignee()}
						</DropdownMenuCheckboxItem>
						{canReorder && (
							<DropdownMenuCheckboxItem
								data-testid="reorder-mode"
								checked={reordering}
								onCheckedChange={setReordering}
							>
								{m.list_reorder_mode()}
							</DropdownMenuCheckboxItem>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuSub>
							<DropdownMenuSubTrigger data-testid="add-from-template">
								{m.list_add_from_template()}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								{taskTemplates.length === 0 ? (
									<DropdownMenuItem disabled>
										{m.list_no_task_templates()}
									</DropdownMenuItem>
								) : (
									taskTemplates.map((t) => (
										<DropdownMenuItem
											key={t.id}
											onSelect={() => addFromTemplate(t.id)}
										>
											{t.name}
										</DropdownMenuItem>
									))
								)}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuItem
							data-testid="save-as-template"
							onSelect={saveAsTemplate}
						>
							{m.list_save_as_template()}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<RowActions
					actions={rowActions}
					label={m.row_actions_for({ name: openList.title })}
				/>
			</div>

			{kind === "project" && !tasksLoading && (
				<ListProgress
					showLabel
					done={doneCount}
					total={listTasks.length}
					className="-mt-3 mb-5"
				/>
			)}

			<AttachmentList
				ref={attachmentsRef}
				workspaceId={openList.workspaceId}
				parentKind="list"
				parentId={openList.id}
				onEmptyFocus={() =>
					listHeaderRef.current
						?.querySelector<HTMLButtonElement>('[data-testid="row-actions"]')
						?.focus()
				}
			/>

			{isDesktop && addForm}

			{reorderActive && (
				<div
					data-testid="reorder-bar"
					className="mb-2 flex items-center justify-between gap-2 rounded-lg bg-muted ps-3 text-sm text-muted-foreground"
				>
					<span>{m.list_reorder_hint()}</span>
					<Button
						variant="ghost"
						className="min-h-11"
						onClick={() => setReordering(false)}
					>
						{m.list_reorder_done()}
					</Button>
				</div>
			)}

			{error && (
				<p role="alert" className="mb-2 text-sm text-destructive">
					{error}
				</p>
			)}

			{tasksLoading ? (
				<TaskListSkeleton />
			) : parents.length === 0 ? (
				<EmptyState
					data-testid="list-empty"
					icon={ListTodo}
					message={m.list_empty()}
				>
					<Button
						data-testid="list-empty-add"
						variant="outline"
						onClick={() => {
							if (titleInput.current?.getClientRects().length) {
								titleInput.current.focus();
							} else {
								onQuickAdd();
							}
						}}
					>
						{m.list_empty_action()}
					</Button>
				</EmptyState>
			) : groupByAssignee ? (
				<div className="flex flex-col gap-4">
					{assigneeGroups.map((g) => (
						<section key={g.key || "unassigned"}>
							<h3 className="mb-1 px-1 text-xs font-medium text-muted-foreground">
								{g.label}
							</h3>
							<TaskList
								list={list}
								tasks={g.tasks}
								subtasksByParent={subtasksByParent}
								labelsByTask={labelsByTask}
								handlers={handlers}
								sortable={false}
							/>
						</section>
					))}
					{mobileAdd}
				</div>
			) : (
				<TaskList
					list={list}
					tasks={parents}
					subtasksByParent={subtasksByParent}
					labelsByTask={labelsByTask}
					handlers={handlers}
					reordering={reorderActive}
					footer={mobileAdd}
				/>
			)}
			{!tasksLoading && parents.length === 0 && mobileAdd}

			<IconPicker
				open={iconOpen}
				onOpenChange={setIconOpen}
				kind={kind}
				title={list.title}
				current={list.icon}
				onSelect={(icon) => {
					if (!canEditContainer) {
						setError(m.activation_container_paused());
						return;
					}
					void run(zero.mutate(mutators.list.update({ id: list.id, icon })));
				}}
			/>

			<ScheduleSheet
				task={scheduleTask}
				open={scheduleTaskId != null}
				onOpenChange={(o) => {
					if (!o) setScheduleTaskId(null);
				}}
				onPick={(dueAt, dueAllDay) => {
					if (scheduleTaskId && activation.canWriteTask(scheduleTaskId))
						void run(
							zero.mutate(
								mutators.task.update({ id: scheduleTaskId, dueAt, dueAllDay }),
							),
						);
				}}
			/>

			<TaskDetail
				task={detailTask}
				open={detailTaskId != null}
				onOpenChange={(o) => {
					if (!o) setDetailTaskId(null);
				}}
				list={list}
				allLists={lists}
				allTasks={tasks}
				allLabels={labels}
				taskLabelIds={
					detailTaskId ? (labelIdsByTask.get(detailTaskId) ?? []) : []
				}
			/>
		</div>
	);
}
