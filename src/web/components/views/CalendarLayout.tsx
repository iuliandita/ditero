import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	MouseSensor,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { CalendarClock, ChevronLeft, ChevronRight, Repeat } from "lucide-react";
import { type JSX, useMemo, useRef, useState } from "react";
import { todayISO } from "@/lib/today";
import { cn } from "@/lib/utils";
import { expand } from "../../../domain/recurrence.ts";
import type { Task } from "../../../zero/schema.gen.ts";
import type { ViewEntry } from "./ViewRenderer.tsx";

const DAY_MS = 86_400_000;

// Week starts Monday (matches the domain's 0=Mon weekday convention).
const WEEKDAYS = [
	{ short: "Mon", full: "Monday" },
	{ short: "Tue", full: "Tuesday" },
	{ short: "Wed", full: "Wednesday" },
	{ short: "Thu", full: "Thursday" },
	{ short: "Fri", full: "Friday" },
	{ short: "Sat", full: "Saturday" },
	{ short: "Sun", full: "Sunday" },
];

// All date math is UTC to match the domain modules (recurrence.expand,
// todayISO): a "YYYY-MM-DD" key is the UTC calendar day so occurrence dates and
// dueAt land on the same cell with no timezone off-by-one.
function utcKey(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}
function keyToUtcMs(key: string): number {
	const [y, m, d] = key.split("-").map(Number);
	return Date.UTC(y, m - 1, d);
}

type DayItem = { entry: ViewEntry; occurrence: boolean };

function longDate(ms: number): string {
	return new Date(ms).toLocaleDateString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
}

function Chip({
	item,
	dragId,
	dragEnabled,
	onOpen,
}: {
	item: DayItem;
	dragId: string;
	dragEnabled: boolean;
	onOpen: (task: Task) => void;
}): JSX.Element {
	const task = item.entry.task;
	const { attributes, listeners, setNodeRef, transform } = useDraggable({
		id: dragId,
		data: { taskId: task.id },
		disabled: !dragEnabled,
	});
	const style = transform
		? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 20 }
		: undefined;
	return (
		<button
			ref={setNodeRef}
			type="button"
			data-testid="calendar-chip"
			style={style}
			onClick={() => onOpen(task)}
			aria-label={item.occurrence ? `${task.title}, recurring` : task.title}
			className={cn(
				"flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-start text-xs text-foreground",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
				// Occurrences read as "generated" via a dashed border + muted fill +
				// the repeat glyph, not low-contrast text (keeps AA at this size).
				item.occurrence
					? "border border-dashed border-border bg-muted/50"
					: "bg-primary/10",
				dragEnabled && "cursor-grab touch-none",
			)}
			{...(dragEnabled ? { ...attributes, ...listeners } : {})}
		>
			{item.occurrence && (
				<Repeat className="size-3 shrink-0" aria-hidden="true" />
			)}
			<span className="truncate">{task.title}</span>
		</button>
	);
}

function DayCell({
	cellMs,
	inMonth,
	isToday,
	items,
	index,
	activeIdx,
	registerRef,
	onFocusDay,
	onOpen,
}: {
	cellMs: number;
	inMonth: boolean;
	isToday: boolean;
	items: DayItem[];
	index: number;
	activeIdx: number;
	registerRef: (i: number, el: HTMLButtonElement | null) => void;
	onFocusDay: (i: number) => void;
	onOpen: (task: Task) => void;
}): JSX.Element {
	const key = utcKey(cellMs);
	const { setNodeRef, isOver } = useDroppable({ id: `day:${key}` });
	const dayNum = new Date(cellMs).getUTCDate();
	const label = isToday ? `${longDate(cellMs)}, today` : longDate(cellMs);
	return (
		<td
			ref={setNodeRef}
			className={cn(
				"h-24 min-w-0 border border-border p-1 align-top",
				// Out-of-month days dim via a muted fill, not opacity (opacity would
				// composite the text below the AA contrast threshold).
				!inMonth && "bg-muted/30",
				isOver && "ring-2 ring-inset ring-ring",
			)}
		>
			<div className="flex h-full flex-col gap-0.5">
				<button
					ref={(el) => registerRef(index, el)}
					type="button"
					tabIndex={index === activeIdx ? 0 : -1}
					aria-label={label}
					onFocus={() => onFocusDay(index)}
					className={cn(
						"size-6 shrink-0 self-start rounded text-xs",
						"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
						!inMonth && !isToday && "text-muted-foreground",
						isToday && "font-semibold text-primary ring-2 ring-primary",
					)}
				>
					{dayNum}
				</button>
				<div className="flex flex-col gap-0.5 overflow-hidden">
					{items.map((it) => (
						<Chip
							key={it.entry.task.id}
							item={it}
							dragId={`chip:${it.entry.task.id}:${key}`}
							dragEnabled
							onOpen={onOpen}
						/>
					))}
				</div>
			</div>
		</td>
	);
}

function Agenda({
	groups,
	onOpen,
}: {
	groups: { key: string; label: string; items: DayItem[] }[];
	onOpen: (task: Task) => void;
}): JSX.Element {
	if (groups.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">Nothing scheduled here.</p>
		);
	}
	return (
		<div className="flex flex-col gap-3" data-testid="calendar-agenda">
			{groups.map((g) => (
				<section key={g.key} aria-label={g.label}>
					<h3 className="mb-1 px-1 text-xs font-medium text-muted-foreground">
						{g.label}
					</h3>
					<ul className="flex flex-col gap-0.5">
						{g.items.map((it) => (
							<li key={it.entry.task.id}>
								<button
									type="button"
									data-testid="agenda-item"
									onClick={() => onOpen(it.entry.task)}
									aria-label={
										it.occurrence
											? `${it.entry.task.title}, recurring`
											: it.entry.task.title
									}
									className={cn(
										"flex w-full items-center gap-1.5 rounded px-1 py-1 text-start text-sm",
										"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
										it.occurrence && "text-muted-foreground",
									)}
								>
									{it.occurrence && (
										<Repeat className="size-3.5 shrink-0" aria-hidden="true" />
									)}
									<span className="truncate">{it.entry.task.title}</span>
								</button>
							</li>
						))}
					</ul>
				</section>
			))}
		</div>
	);
}

// Month-grid + agenda view over the filtered task set. On md+ it renders a
// today-ringed month grid (drag a chip to another day to reschedule dueAt) with
// the agenda below; on < md it collapses to the agenda alone with a "viewing as
// agenda" note (mirrors the board/table list-collapse affordance). Concrete
// dued tasks render solid; recurring occurrences (recurrence.expand across the
// visible range) render lighter/dashed so a rule instance reads as generated.
// The keyboard alternative to drag-reschedule is the task-detail due editor
// (open a chip -> edit due); the grid is a native table, arrow-key navigable.
export function CalendarLayout({
	entries,
	isDesktop,
	onOpenTask,
	onReschedule,
}: {
	entries: ViewEntry[];
	isDesktop: boolean;
	onOpenTask: (task: Task) => void;
	onReschedule: (taskId: string, dueAt: number) => void;
}): JSX.Element {
	const [monthMs, setMonthMs] = useState(() => {
		const [y, m] = todayISO().split("-").map(Number);
		return Date.UTC(y, m - 1, 1);
	});
	const [activeIdx, setActiveIdx] = useState(0);
	const dayRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
	);

	const taskById = useMemo(
		() => new Map(entries.map((e) => [e.task.id, e.task])),
		[entries],
	);

	const { weeks, monthIndex, gridStartMs, gridEndMs } = useMemo(() => {
		const first = new Date(monthMs);
		const lead = (first.getUTCDay() + 6) % 7; // days before the 1st (Mon start)
		const start = monthMs - lead * DAY_MS;
		const cells = Array.from({ length: 42 }, (_, i) => start + i * DAY_MS);
		const rows: number[][] = [];
		for (let w = 0; w < 6; w++) rows.push(cells.slice(w * 7, w * 7 + 7));
		return {
			weeks: rows,
			monthIndex: first.getUTCMonth(),
			gridStartMs: start,
			gridEndMs: start + 42 * DAY_MS,
		};
	}, [monthMs]);

	const monthLabel = new Date(monthMs).toLocaleDateString("en-US", {
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	});

	const byDate = useMemo(() => {
		const map = new Map<string, DayItem[]>();
		const push = (key: string, item: DayItem) => {
			const bucket = map.get(key);
			if (bucket) bucket.push(item);
			else map.set(key, [item]);
		};
		const from = new Date(gridStartMs);
		const to = new Date(gridEndMs);
		for (const entry of entries) {
			const task = entry.task;
			if (task.rrule) {
				// A malformed rrule is best-effort here (write-side validates); skip its
				// occurrences rather than crash the whole month surface.
				let occ: Date[] = [];
				try {
					occ = expand(task.rrule, from, to);
				} catch {
					occ = [];
				}
				for (const d of occ)
					push(utcKey(d.getTime()), { entry, occurrence: true });
			} else if (task.dueAt != null) {
				push(utcKey(task.dueAt), { entry, occurrence: false });
			}
		}
		return map;
	}, [entries, gridStartMs, gridEndMs]);

	const agendaGroups = useMemo(
		() =>
			[...byDate.keys()].sort().map((key) => ({
				key,
				label: longDate(keyToUtcMs(key)),
				items: byDate.get(key) ?? [],
			})),
		[byDate],
	);

	function shiftMonth(delta: number) {
		const d = new Date(monthMs);
		setMonthMs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1));
		setActiveIdx(0);
	}

	function reschedule(taskId: string, targetKey: string) {
		const task = taskById.get(taskId);
		if (!task) return;
		const targetMid = keyToUtcMs(targetKey);
		// Preserve time-of-day for a timed task; an all-day (or undated) task lands
		// at UTC midnight and stays all-day (dueAllDay is left untouched).
		const dueAt =
			task.dueAt != null && !task.dueAllDay
				? targetMid + (task.dueAt - keyToUtcMs(utcKey(task.dueAt)))
				: targetMid;
		onReschedule(taskId, dueAt);
	}

	function onDragEnd(e: DragEndEvent) {
		const { active, over } = e;
		if (!over) return;
		const overId = String(over.id);
		if (!overId.startsWith("day:")) return;
		const taskId = active.data.current?.taskId as string | undefined;
		if (!taskId) return;
		reschedule(taskId, overId.slice("day:".length));
	}

	function registerRef(i: number, el: HTMLButtonElement | null) {
		dayRefs.current[i] = el;
	}
	function focusDay(i: number) {
		if (i < 0 || i > 41) return;
		setActiveIdx(i);
		dayRefs.current[i]?.focus();
	}
	function onGridKeyDown(e: React.KeyboardEvent) {
		const moves: Record<string, number> = {
			ArrowRight: 1,
			ArrowLeft: -1,
			ArrowDown: 7,
			ArrowUp: -7,
		};
		const delta = moves[e.key];
		if (delta === undefined) return;
		const next = activeIdx + delta;
		if (next < 0 || next > 41) return;
		e.preventDefault();
		focusDay(next);
	}

	const agenda = <Agenda groups={agendaGroups} onOpen={onOpenTask} />;

	if (!isDesktop) {
		return (
			<div data-testid="calendar-surface">
				<p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
					<CalendarClock className="size-3.5" />
					Viewing as agenda
				</p>
				{agenda}
			</div>
		);
	}

	return (
		<div data-testid="calendar-surface" className="flex flex-col gap-4">
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-medium">{monthLabel}</h2>
				<div className="flex items-center gap-1">
					<button
						type="button"
						data-testid="calendar-prev"
						aria-label="Previous month"
						onClick={() => shiftMonth(-1)}
						className="flex size-7 items-center justify-center rounded border border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					>
						<ChevronLeft className="size-4" />
					</button>
					<button
						type="button"
						data-testid="calendar-next"
						aria-label="Next month"
						onClick={() => shiftMonth(1)}
						className="flex size-7 items-center justify-center rounded border border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					>
						<ChevronRight className="size-4" />
					</button>
				</div>
			</div>
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={onDragEnd}
			>
				<table
					className="w-full table-fixed border-collapse text-sm"
					onKeyDown={onGridKeyDown}
				>
					<caption className="sr-only">{monthLabel}</caption>
					<thead>
						<tr>
							{WEEKDAYS.map((w) => (
								<th
									key={w.short}
									scope="col"
									className="px-1 py-1 text-center text-xs font-medium text-muted-foreground"
								>
									<abbr title={w.full} className="no-underline">
										{w.short}
									</abbr>
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{weeks.map((week, wi) => (
							<tr key={utcKey(week[0])}>
								{week.map((cellMs, di) => {
									const key = utcKey(cellMs);
									return (
										<DayCell
											key={key}
											cellMs={cellMs}
											inMonth={new Date(cellMs).getUTCMonth() === monthIndex}
											isToday={key === todayISO()}
											items={byDate.get(key) ?? []}
											index={wi * 7 + di}
											activeIdx={activeIdx}
											registerRef={registerRef}
											onFocusDay={setActiveIdx}
											onOpen={onOpenTask}
										/>
									);
								})}
							</tr>
						))}
					</tbody>
				</table>
			</DndContext>
			<section aria-label="Agenda">
				<h3 className="mb-2 text-xs font-medium text-muted-foreground">
					Agenda
				</h3>
				{agenda}
			</section>
		</div>
	);
}
