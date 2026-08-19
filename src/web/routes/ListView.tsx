import { useQuery, useZero } from "@rocicorp/zero/react";
import { SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
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
import { ListIcon } from "@/lib/list-icon";
import { runMutation } from "@/lib/run-mutation";
import type { ListKind } from "../../domain/icon-map.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import type { CompletedDisplay } from "../../domain/task-sort.ts";
import { snapshotList } from "../../domain/template.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { Label, List, schema, Task } from "../../zero/schema.gen.ts";
import { IconPicker } from "../components/list/IconPicker.tsx";
import { ScheduleSheet } from "../components/list/ScheduleSheet.tsx";
import { TaskDetail } from "../components/list/TaskDetail.tsx";
import { TaskList } from "../components/list/TaskList.tsx";
import type { RowAction } from "../components/ui/row-action.ts";
import { RowActions } from "../components/ui/row-actions.tsx";

const DISPLAY_MODES: CompletedDisplay[] = ["sink", "keep", "hide"];

// Thunks: resolving `m` at module scope would freeze the import-time locale.
const DISPLAY_MODE_LABELS: Record<CompletedDisplay, () => string> = {
	sink: m.list_completed_sink,
	keep: m.list_completed_keep,
	hide: m.list_completed_hide,
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
}: {
	listId: string;
	listActions: (list: List) => RowAction[];
}) {
	const zero = useZero<typeof schema>();
	const [tasks] = useQuery(queries.tasks.mine());
	const [lists] = useQuery(queries.lists.mine());
	const [labels] = useQuery(queries.labels.mine());
	const [taskLabels] = useQuery(queries.taskLabels.mine());
	const [assignees] = useQuery(queries.assignees.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const [templates] = useQuery(queries.templates.mine());
	const [title, setTitle] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [iconOpen, setIconOpen] = useState(false);
	const [groupByAssignee, setGroupByAssignee] = useState(false);
	const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
	const [scheduleTaskId, setScheduleTaskId] = useState<string | null>(null);

	const list = lists.find((l) => l.id === listId);
	const listTasks = useMemo(
		() => tasks.filter((t) => t.listId === listId),
		[tasks, listId],
	);
	const parents = useMemo(
		() => listTasks.filter((t) => t.parentId == null),
		[listTasks],
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

	async function createTask() {
		const t = title.trim();
		if (!t) return;
		setTitle("");
		await run(
			zero.mutate(
				mutators.task.create({
					id: crypto.randomUUID(),
					listId,
					title: t,
					sortKey: keyBetween(lastKey(parents), null),
				}),
			),
		);
	}

	if (!list) return null;
	// Narrowed alias so nested function declarations keep the non-null type.
	const openList = list;
	const taskTemplates = templates.filter(
		(t) => t.kind === "task" && t.workspaceId === openList.workspaceId,
	);
	const kind = (list.kind ?? "tasks") as ListKind;
	const mode = (list.completedDisplay ?? "sink") as CompletedDisplay;

	const handlers = {
		onToggle: (id: string, done: boolean) =>
			void run(
				zero.mutate(
					done
						? mutators.task.update({ id, done: false })
						: mutators.task.complete({ id }),
				),
			),
		onOpenDetail: (task: { id: string }) => setDetailTaskId(task.id),
		onSchedule: (task: { id: string }) => setScheduleTaskId(task.id),
		onMove: (id: string, sortKey: string) =>
			void run(zero.mutate(mutators.task.update({ id, sortKey }))),
		onUpdate: (id: string, patch: { quantity?: string; unit?: string }) =>
			void run(zero.mutate(mutators.task.update({ id, ...patch }))),
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
					id: crypto.randomUUID(),
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
					taskId: crypto.randomUUID(),
					listId,
					sortKey: keyBetween(lastKey(parents), null),
				}),
			),
		);
	}

	return (
		<div data-testid="list" className="max-w-3xl">
			{/* `group` is what RowActions' md:group-hover reveal keys off. */}
			<div className="group mb-4 flex items-center gap-2">
				<button
					type="button"
					aria-label={m.list_change_icon()}
					onClick={() => setIconOpen(true)}
					className="flex size-9 shrink-0 items-center justify-center rounded-lg border"
				>
					<ListIcon icon={list.icon} kind={kind} title={list.title} />
				</button>
				<h2 className="min-w-0 flex-1 truncate text-lg font-semibold">
					{list.title}
				</h2>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={m.list_display_options()}
						>
							<SlidersHorizontal />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuLabel>{m.list_completed_heading()}</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={mode}
							onValueChange={(v) =>
								void run(
									zero.mutate(
										mutators.list.update({
											id: list.id,
											completedDisplay: v as CompletedDisplay,
										}),
									),
								)
							}
						>
							{DISPLAY_MODES.map((value) => (
								<DropdownMenuRadioItem key={value} value={value}>
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
					actions={listActions(openList)}
					label={m.row_actions_for({ name: openList.title })}
				/>
			</div>

			<div className="mb-3 flex gap-2">
				<input
					data-testid="new-task"
					className="h-9 flex-1 rounded-lg border bg-transparent px-3 text-base md:text-sm"
					placeholder={m.list_add_task_placeholder()}
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void createTask();
					}}
				/>
				<Button
					data-testid="new-task-submit"
					type="button"
					onClick={() => void createTask()}
				>
					{m.list_add_task()}
				</Button>
			</div>

			{error && (
				<p role="alert" className="mb-2 text-sm text-destructive">
					{error}
				</p>
			)}

			{groupByAssignee ? (
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
				</div>
			) : (
				<TaskList
					list={list}
					tasks={parents}
					subtasksByParent={subtasksByParent}
					labelsByTask={labelsByTask}
					handlers={handlers}
				/>
			)}

			<IconPicker
				open={iconOpen}
				onOpenChange={setIconOpen}
				kind={kind}
				title={list.title}
				current={list.icon}
				onSelect={(icon) =>
					void run(zero.mutate(mutators.list.update({ id: list.id, icon })))
				}
			/>

			<ScheduleSheet
				task={scheduleTask}
				open={scheduleTaskId != null}
				onOpenChange={(o) => {
					if (!o) setScheduleTaskId(null);
				}}
				onPick={(dueAt, dueAllDay) => {
					if (scheduleTaskId)
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
