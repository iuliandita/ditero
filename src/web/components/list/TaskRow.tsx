import { useQuery, useZero } from "@rocicorp/zero/react";
import { CalendarClock, Check, ChevronRight, Flag } from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useMemo,
	useRef,
	useState,
} from "react";
import { AssigneeChips } from "@/components/people/AssigneeChips";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
	formatDue,
	isOverdue,
	priorityLabel,
	priorityMeta,
} from "@/lib/task-display";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import { randomId } from "../../../domain/random-id.ts";
import type { Role } from "../../../domain/role.ts";
import { snapshotTask } from "../../../domain/template.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { Label, schema, Task } from "../../../zero/schema.gen.ts";
import { ReminderChip } from "../task/ReminderChip.tsx";
import { useConfirm } from "../ui/confirm.tsx";
import { RowActions, useRowContextMenu } from "../ui/row-actions.tsx";
import { type Due, taskActions } from "./taskActions.ts";

export type RowHandlers = {
	onToggle: (id: string, done: boolean) => void;
	onOpenDetail: (task: Task) => void;
	onSchedule?: (task: Task) => void;
};

const SWIPE_THRESHOLD = 72;

// Touch swipe on a task row (design 2.6): right = toggle done (green; a done
// row un-completes, an open row completes), left = schedule (blue). Touch-only
// so it never competes with mouse click or the reorder handle; vertical scroll
// is preserved via touch-action pan-y. Under prefers-reduced-motion the finger-
// follow transform still tracks directly but the snap/commit transition is
// dropped for an instant state change.
function SwipeRow({
	children,
	onComplete,
	onSchedule,
}: {
	children: ReactNode;
	onComplete: () => void;
	onSchedule?: () => void;
}) {
	const reduce = useReducedMotion();
	const [dx, setDx] = useState(0);
	const dxRef = useRef(0);
	const start = useRef<{ x: number; y: number; active: boolean } | null>(null);
	// True once a swipe activated in this gesture, so the synthesized click the
	// browser fires on release (even for a sub-threshold drag) is swallowed
	// instead of opening the task detail behind the row.
	const moved = useRef(false);

	function setOffset(v: number) {
		dxRef.current = v;
		setDx(v);
	}
	function onPointerDown(e: ReactPointerEvent) {
		moved.current = false;
		if (e.pointerType !== "touch") return;
		start.current = { x: e.clientX, y: e.clientY, active: false };
	}
	function onPointerMove(e: ReactPointerEvent) {
		const s = start.current;
		if (!s) return;
		const mx = e.clientX - s.x;
		const my = e.clientY - s.y;
		if (!s.active) {
			if (Math.abs(mx) < 10) return;
			// Vertical intent -> release so the list scrolls normally.
			if (Math.abs(mx) <= Math.abs(my)) {
				start.current = null;
				return;
			}
			s.active = true;
			moved.current = true;
			e.currentTarget.setPointerCapture?.(e.pointerId);
		}
		let v = mx;
		if (v < 0 && !onSchedule) v = 0; // no left action -> no left travel
		setOffset(Math.max(-140, Math.min(140, v)));
	}
	function onPointerUp() {
		const s = start.current;
		start.current = null;
		if (s?.active) {
			if (dxRef.current >= SWIPE_THRESHOLD) onComplete();
			else if (dxRef.current <= -SWIPE_THRESHOLD && onSchedule) onSchedule();
		}
		setOffset(0);
	}
	function onClickCapture(e: ReactMouseEvent) {
		if (!moved.current) return;
		// Swallow the click synthesized after an active swipe (any distance).
		e.preventDefault();
		e.stopPropagation();
		moved.current = false;
	}

	const active = start.current?.active ?? false;
	return (
		<div className="relative overflow-hidden">
			<div
				className="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3 text-success"
				style={{ opacity: dx > 0 ? 1 : 0 }}
			>
				<Check className="size-4" />
			</div>
			{onSchedule && (
				<div
					className="pointer-events-none absolute inset-y-0 end-0 flex items-center pe-3 text-info"
					style={{ opacity: dx < 0 ? 1 : 0 }}
				>
					<CalendarClock className="size-4" />
				</div>
			)}
			<div
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onClickCapture={onClickCapture}
				className="touch-pan-y bg-background"
				style={{
					transform: `translateX(${dx}px)`,
					transition:
						active || reduce
							? "none"
							: "transform var(--motion-base) var(--motion-ease)",
				}}
			>
				{children}
			</div>
		</div>
	);
}

function DueChip({ task }: { task: Task }) {
	if (task.dueAt == null) return null;
	const overdue = isOverdue(task);
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 text-xs",
				overdue ? "text-destructive" : "text-muted-foreground",
			)}
		>
			<CalendarClock className="size-3" />
			{formatDue(task.dueAt, task.dueAllDay)}
		</span>
	);
}

function PriorityFlag({ priority }: { priority: number | null | undefined }) {
	const meta = priorityMeta(priority);
	if (!meta) return null;
	return (
		<Flag
			aria-label={m.task_priority_aria({ priority: priorityLabel(priority) })}
			className={cn("size-3.5 shrink-0 fill-current", meta.color)}
		/>
	);
}

export function TaskRow({
	task,
	kind,
	subtasks,
	labels,
	handlers,
}: {
	task: Task;
	kind: ListKind;
	subtasks: Task[];
	labels: Label[];
	handlers: RowHandlers;
}) {
	const [expanded, setExpanded] = useState(false);
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();
	const [lists] = useQuery(queries.lists.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const [allTasks] = useQuery(queries.tasks.mine());
	const bare = kind === "checklist";
	const doneCount = subtasks.filter((s) => s.done).length;
	const total = subtasks.length;
	const progress = total > 0 ? doneCount / total : 0;

	// The caller's role in the workspace owning this task's list. The mutators
	// re-check on write; this only keeps the menu from offering a refusal.
	const role = useMemo<Role | null>(() => {
		const list = lists.find((l) => l.id === task.listId);
		if (!list) return null;
		const mine = memberships.find(
			(mem) =>
				mem.userId === zero.userID && mem.workspaceId === list.workspaceId,
		);
		return (mine?.role as Role) ?? null;
	}, [lists, memberships, task.listId, zero.userID]);

	function update(fields: Partial<Due> & { priority?: number }) {
		void zero
			.mutate(mutators.task.update({ id: task.id, ...fields }))
			.client.catch((e) => console.error("task.update failed", e));
	}

	async function removeTask() {
		// Counted from the synced task set, not the `subtasks` prop: three of the
		// four TaskRow surfaces pass [], and task.delete cascades children, so the
		// prop would understate the blast radius the confirm exists to state.
		const count = allTasks.filter((t) => t.parentId === task.id).length;
		const ok = await confirm({
			title: m.task_delete_title(),
			body:
				count > 0
					? m.task_delete_confirm_subtasks({ title: task.title, count })
					: m.task_delete_confirm({ title: task.title }),
			confirmLabel: m.action_delete(),
			destructive: true,
		});
		if (!ok) return;
		void zero
			.mutate(mutators.task.delete({ id: task.id }))
			.client.catch((e) => console.error("task.delete failed", e));
	}

	// Snapshot this task with one level of subtasks into a workspace template; it
	// then appears in the list header's add-from-template menu. Subtasks come from
	// the synced set, not the `subtasks` prop, for the same reason removeTask
	// counts there: three of the four TaskRow surfaces pass [].
	function saveAsTemplate() {
		const list = lists.find((l) => l.id === task.listId);
		if (!list) return;
		const subs = allTasks
			.filter((t) => t.parentId === task.id)
			.sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
		void zero
			.mutate(
				mutators.template.save({
					id: randomId(),
					workspaceId: list.workspaceId,
					name: task.title,
					kind: "task",
					content: snapshotTask(task, subs),
				}),
			)
			.client.catch((e) => console.error("template.save failed", e));
	}

	const actions = taskActions({
		task,
		kind,
		role,
		handlers: {
			open: handlers.onOpenDetail,
			schedule: (_t, due) => update(due),
			pickDate: handlers.onSchedule,
			setPriority: (_t, priority) => update({ priority }),
			saveAsTemplate,
			remove: () => void removeTask(),
		},
	});
	const actionsLabel = m.row_actions_for({ name: task.title });
	const canDelete = actions.some((a) => a.id === "delete" && !a.hidden);
	const { rowProps, menu } = useRowContextMenu(actions, actionsLabel);

	return (
		<div className="rounded-lg">
			<SwipeRow
				onComplete={() => handlers.onToggle(task.id, task.done ?? false)}
				onSchedule={
					handlers.onSchedule ? () => handlers.onSchedule?.(task) : undefined
				}
			>
				{/* data-kbd-row scopes the roving row actions to this row; the open
				    button carries data-kbd-nav (roving focus + open target). `group`
				    is what RowActions' md:group-hover reveal keys off. */}
				<div
					className="group flex items-start gap-2 rounded-lg py-1.5 transition-colors duration-(--motion-fast) ease-(--motion-ease) motion-reduce:transition-none hover:bg-muted/40 active:bg-muted/60"
					data-kbd-row
					{...rowProps}
				>
					<Checkbox
						aria-label={task.title}
						checked={task.done ?? false}
						onCheckedChange={() =>
							handlers.onToggle(task.id, task.done ?? false)
						}
						data-kbd-action="toggle"
						className="mt-0.5"
					/>
					<button
						type="button"
						data-kbd-nav
						onClick={() => handlers.onOpenDetail(task)}
						className="min-w-0 flex-1 text-start"
					>
						<span
							className={cn(
								"block truncate text-sm",
								task.done && "text-muted-foreground line-through",
							)}
						>
							{task.title}
						</span>
						{!bare && (
							<div className="mt-0.5 flex flex-wrap items-center gap-2">
								<AssigneeChips taskId={task.id} />
								<DueChip task={task} />
								{labels.map((l) => (
									<Badge key={l.id} variant="outline" className="h-4 px-1.5">
										{l.name}
									</Badge>
								))}
								{total > 0 && kind !== "project" && (
									<span className="text-xs text-muted-foreground">
										{m.task_subtask_progress({ done: doneCount, total })}
									</span>
								)}
							</div>
						)}
						{kind === "project" && total > 0 && (
							<div className="mt-1 flex items-center gap-2">
								<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
									<div
										className="h-full rounded-full bg-kind-project"
										style={{ width: `${Math.round(progress * 100)}%` }}
									/>
								</div>
								<span className="text-xs text-muted-foreground">
									{m.task_subtask_progress({ done: doneCount, total })}
								</span>
							</div>
						)}
					</button>
					{/* Outside the title button: the chip is itself a control when the
					    reminder is still live, and a button cannot nest in a button. */}
					{!bare && <ReminderChip task={task} />}
					{!bare && <PriorityFlag priority={task.priority} />}
					{total > 0 && (
						<button
							type="button"
							aria-label={
								expanded ? m.subtasks_collapse() : m.subtasks_expand()
							}
							aria-expanded={expanded}
							onClick={() => setExpanded((e) => !e)}
							className="mt-0.5 text-muted-foreground"
						>
							<ChevronRight
								className={cn(
									"size-4 transition-transform",
									expanded ? "rotate-90" : "rtl:rotate-180",
								)}
							/>
						</button>
					)}
					<RowActions actions={actions} label={actionsLabel} />
					{/* The keyboard's delete target. It cannot be the menu item: Radix
					    portals the menu content out of this row, and the item exists
					    only while the menu is open, so actOnFocused could never find
					    it. Same indirection data-kbd-action="toggle" already uses.
					    Absent without the permission, so the binding no-ops rather
					    than confirming a delete the mutator would refuse. */}
					{canDelete && (
						<button
							type="button"
							data-kbd-action="delete"
							className="sr-only"
							tabIndex={-1}
							aria-hidden
							onClick={() => void removeTask()}
						/>
					)}
				</div>
			</SwipeRow>
			{menu}
			{expanded && total > 0 && (
				<ul className="ms-6 flex flex-col border-s ps-2">
					{subtasks.map((s) => (
						<li key={s.id} className="flex items-center gap-2 py-1">
							<Checkbox
								aria-label={s.title}
								checked={s.done ?? false}
								onCheckedChange={() => handlers.onToggle(s.id, s.done ?? false)}
							/>
							<button
								type="button"
								onClick={() => handlers.onOpenDetail(s)}
								className={cn(
									"min-w-0 flex-1 truncate text-start text-sm",
									s.done && "text-muted-foreground line-through",
								)}
							>
								{s.title}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
