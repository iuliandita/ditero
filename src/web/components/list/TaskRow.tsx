import { useQuery, useZero } from "@rocicorp/zero/react";
import {
	CalendarClock,
	Check,
	ChevronRight,
	Flag,
	ListChecks,
} from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { AssigneeChips } from "@/components/people/AssigneeChips";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { checkShapeFor, checkToneFor } from "@/lib/check-shape";
import {
	CHECK_POP,
	strikeClass,
	useJustCompleted,
} from "@/lib/completion-feedback";
import {
	formatDue,
	isOverdue,
	priorityLabel,
	priorityMeta,
} from "@/lib/task-display";
import { TOUCH_KEYBOARD_ONLY } from "@/lib/touch";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import { randomId } from "../../../domain/random-id.ts";
import type { Role } from "../../../domain/role.ts";
import { snapshotTask } from "../../../domain/template.ts";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import { queries } from "../../../zero/queries.ts";
import type { Label, schema, Task } from "../../../zero/schema.gen.ts";
import { useTaskImportActivationMap } from "../../hooks/useTaskImportActivation.ts";
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
	onComplete?: () => void;
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
		if (!onComplete && !onSchedule) return;
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
			if ((mx > 0 && !onComplete) || (mx < 0 && !onSchedule)) {
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
			if (dxRef.current >= SWIPE_THRESHOLD) onComplete?.();
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
			{onComplete && (
				<div
					className="pointer-events-none absolute inset-y-0 start-0 flex items-center ps-3 text-success"
					style={{ opacity: dx > 0 ? 1 : 0 }}
				>
					<Check className="size-4" />
				</div>
			)}
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

// Fill density carries the level without hue: solid high, tinted medium, open
// low. The ring and the flag carry the priority color on top of that.
const FLAG_FILL: Record<number, string> = {
	3: "fill-current",
	2: "fill-current/30",
	1: "fill-none",
};

function PriorityFlag({
	id,
	priority,
}: {
	id: string;
	priority: number | null | undefined;
}) {
	const meta = priorityMeta(priority);
	if (!meta) return null;
	const label = priorityLabel(priority);
	return (
		<span
			id={id}
			role="img"
			aria-label={m.task_priority_aria({ priority: label })}
			data-testid="task-priority"
			data-priority={meta.value}
			className="inline-flex shrink-0 items-center gap-1"
		>
			{/* The word appears where a pointer can hover or the keyboard is in
			    the row; touch keeps the flag alone, per the one-cue row. */}
			<span
				aria-hidden
				data-testid="task-priority-text"
				className="hidden text-xs text-muted-foreground group-hover:inline group-has-[:focus-visible]:inline"
			>
				{label}
			</span>
			<Flag
				aria-hidden
				className={cn("size-3.5", meta.color, FLAG_FILL[meta.value])}
			/>
		</span>
	);
}

function SubtaskCount({ done, total }: { done: number; total: number }) {
	return (
		<span
			data-testid="subtask-count"
			className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
		>
			<ListChecks aria-hidden className="size-3" />
			<span aria-hidden>{m.task_subtask_progress({ done, total })}</span>
			<span className="sr-only">
				{m.task_subtask_progress_aria({ done, total })}
			</span>
		</span>
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
	const [editError, setEditError] = useState<string | null>(null);
	const zero = useZero<typeof schema>();
	const confirm = useConfirm();
	const [lists] = useQuery(queries.lists.mine());
	const [memberships] = useQuery(queries.memberships.mine());
	const [allTasks] = useQuery(queries.tasks.mine());
	const activation = useTaskImportActivationMap();
	const activationStatus = activation.statusForTask(task.id);
	const canEdit = activation.canWriteTask(task.id);
	const bare = kind === "checklist";
	const doneCount = subtasks.filter((s) => s.done).length;
	const total = subtasks.length;
	const progress = total > 0 ? doneCount / total : 0;
	const justCompleted = useJustCompleted(task.done ?? false);

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
		if (!canEdit) return;
		setEditError(null);
		void zero
			.mutate(mutators.task.update({ id: task.id, ...fields }))
			.client.catch(() => setEditError(m.activation_task_change_failed()));
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
		canEdit,
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
	const ids = useId();
	const badgeId = `${ids}-badge`;
	const metaId = `${ids}-meta`;
	const progressId = `${ids}-progress`;
	const priorityId = `${ids}-priority`;
	const showBadge =
		activationStatus === "pending" || activationStatus === "blocked";
	const showProgress = kind === "project" && total > 0;
	const hasPriority = !bare && priorityMeta(task.priority) != null;
	// The checkbox carries the title and the done state; the open button would
	// only repeat it, so it names its action and points at the row's details.
	const describedBy =
		[
			showBadge && badgeId,
			!bare && metaId,
			showProgress && progressId,
			hasPriority && priorityId,
		]
			.filter(Boolean)
			.join(" ") || undefined;

	return (
		<div>
			<SwipeRow
				onComplete={
					canEdit
						? () => handlers.onToggle(task.id, task.done ?? false)
						: undefined
				}
				onSchedule={
					canEdit && handlers.onSchedule
						? () => handlers.onSchedule?.(task)
						: undefined
				}
			>
				{/* data-kbd-row scopes the roving row actions to this row; the open
				    button carries data-kbd-nav (roving focus + open target). `group`
				    is what RowActions' md:group-hover reveal keys off. */}
				<div
					className="group flex min-h-12 items-center gap-2 rounded-md px-1 py-1 transition-colors duration-(--motion-fast) ease-(--motion-ease) [-webkit-touch-callout:none] motion-reduce:transition-none hover:bg-muted/30 active:bg-muted/50 pointer-coarse:select-none data-long-pressed:bg-muted/60"
					data-kbd-row
					{...rowProps}
				>
					<div className="flex size-11 shrink-0 items-center justify-center md:size-8">
						<Checkbox
							disabled={!canEdit}
							aria-label={task.title}
							checked={task.done ?? false}
							onCheckedChange={() => {
								if (canEdit) handlers.onToggle(task.id, task.done ?? false);
							}}
							data-kbd-action="toggle"
							shape={checkShapeFor(kind)}
							priority={checkToneFor(kind, task.priority)}
							className={cn(
								"after:-inset-3.5 md:after:-inset-2",
								justCompleted && CHECK_POP,
							)}
						/>
					</div>
					<button
						type="button"
						data-kbd-nav
						data-task-id={task.id}
						aria-label={m.task_open_details()}
						aria-describedby={describedBy}
						onClick={() => handlers.onOpenDetail(task)}
						className="min-h-11 min-w-0 flex-1 content-center text-start"
					>
						<span
							className={cn(
								"block truncate text-sm",
								task.done && "text-muted-foreground",
							)}
						>
							<span className={strikeClass(task.done ?? false)}>
								{task.title}
							</span>
						</span>
						{showBadge && (
							<Badge
								id={badgeId}
								variant="outline"
								className="mt-1 text-xs text-warning"
							>
								{activationStatus === "pending"
									? m.activation_badge_pending()
									: m.activation_badge_blocked()}
							</Badge>
						)}
						{!bare && (
							<div
								id={metaId}
								className="mt-0.5 flex flex-wrap items-center gap-2"
							>
								<AssigneeChips taskId={task.id} />
								<DueChip task={task} />
								{labels.map((l) => (
									<Badge
										key={l.id}
										variant="outline"
										className="h-4 border-transparent bg-muted/60 px-1.5 text-muted-foreground"
									>
										{l.name}
									</Badge>
								))}
								{total > 0 && kind !== "project" && (
									<SubtaskCount done={doneCount} total={total} />
								)}
							</div>
						)}
						{showProgress && (
							<div id={progressId} className="mt-1 flex items-center gap-2">
								<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
									<div
										className="h-full rounded-full bg-kind-project"
										style={{ width: `${Math.round(progress * 100)}%` }}
									/>
								</div>
								<SubtaskCount done={doneCount} total={total} />
							</div>
						)}
					</button>
					{/* Outside the title button: the chip is itself a control when the
					    reminder is still live, and a button cannot nest in a button. */}
					{!bare && <ReminderChip task={task} />}
					{!bare && <PriorityFlag id={priorityId} priority={task.priority} />}
					{total > 0 && (
						<button
							type="button"
							aria-label={
								expanded ? m.subtasks_collapse() : m.subtasks_expand()
							}
							aria-expanded={expanded}
							onClick={() => setExpanded((e) => !e)}
							className={cn(
								"mt-0.5 text-muted-foreground",
								TOUCH_KEYBOARD_ONLY,
							)}
						>
							<ChevronRight
								className={cn(
									"size-4 transition-transform",
									expanded ? "rotate-90" : "rtl:rotate-180",
								)}
							/>
						</button>
					)}
					<RowActions actions={actions} label={actionsLabel} hideOnTouch />
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
			{editError && (
				<p role="alert" className="ms-7 text-xs text-destructive">
					{editError}
				</p>
			)}
			{expanded && total > 0 && (
				<ul className="ms-6 flex flex-col border-s ps-2">
					{subtasks.map((s) => (
						<li key={s.id} className="flex items-center gap-2 py-1">
							<Checkbox
								disabled={!activation.canWriteTask(s.id)}
								aria-label={s.title}
								checked={s.done ?? false}
								onCheckedChange={() => {
									if (activation.canWriteTask(s.id))
										handlers.onToggle(s.id, s.done ?? false);
								}}
								shape={checkShapeFor(kind)}
								priority={checkToneFor(kind, s.priority)}
							/>
							<button
								type="button"
								aria-label={m.task_open_details()}
								onClick={() => handlers.onOpenDetail(s)}
								className={cn(
									"min-w-0 flex-1 truncate text-start text-sm",
									s.done && "text-muted-foreground",
								)}
							>
								<span className={strikeClass(s.done ?? false)}>{s.title}</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
