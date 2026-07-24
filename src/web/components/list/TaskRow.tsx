import { CalendarClock, Check, ChevronRight, Flag } from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
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
import { m } from "../../../paraglide/messages.js";
import type { Label, Task } from "../../../zero/schema.gen.ts";
import { ReminderChip } from "../task/ReminderChip.tsx";

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
					transition: active || reduce ? "none" : "transform 150ms ease",
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
	const bare = kind === "checklist";
	const doneCount = subtasks.filter((s) => s.done).length;
	const total = subtasks.length;
	const progress = total > 0 ? doneCount / total : 0;

	return (
		<div className="rounded-lg">
			<SwipeRow
				onComplete={() => handlers.onToggle(task.id, task.done ?? false)}
				onSchedule={
					handlers.onSchedule ? () => handlers.onSchedule?.(task) : undefined
				}
			>
				{/* data-kbd-row scopes the roving toggle action to this row; the open
				    button carries data-kbd-nav (roving focus + open target). */}
				<div className="flex items-start gap-2 py-1.5" data-kbd-row>
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
								"block truncate",
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
									expanded && "rotate-90",
								)}
							/>
						</button>
					)}
				</div>
			</SwipeRow>
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
