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
import { cn } from "@/lib/utils";
import { localDay, shiftDay } from "../../../domain/local-day.ts";
import { expand } from "../../../domain/recurrence.ts";
import {
	instantToWallClock,
	wallClockToInstant,
} from "../../../domain/zoned.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import type { Task } from "../../../zero/schema.gen.ts";
import { EmptyState } from "../ui/empty-state.tsx";
import type { ViewEntry } from "./ViewRenderer.tsx";

const DAY_MS = 86_400_000;

// Week starts Monday (matches the domain's 0=Mon weekday convention); the
// reference week below starts on a UTC Monday.
const WEEK_REF_MS = Date.UTC(2024, 0, 1);

// Built per call, never cached: a module-scope formatter would freeze the
// import-time locale. timeZone is pinned to UTC because the reference instants
// are UTC midnights — without it a negative-offset viewer would see every
// weekday name shifted back a day.
function weekdayNames(): { key: string; short: string; full: string }[] {
	const short = new Intl.DateTimeFormat(getLocale(), {
		weekday: "short",
		timeZone: "UTC",
	});
	const full = new Intl.DateTimeFormat(getLocale(), {
		weekday: "long",
		timeZone: "UTC",
	});
	return Array.from({ length: 7 }, (_, i) => {
		const d = new Date(WEEK_REF_MS + i * DAY_MS);
		return { key: String(i), short: short.format(d), full: full.format(d) };
	});
}

// A "YYYY-MM-DD" key is the user's LOCAL calendar day, the same frame habit
// logs and karma events are written in. It used to be the UTC day, which put a
// task due at 22:00 in New York on tomorrow's cell and highlighted the wrong
// "today" every evening west of UTC. expand() returns real instants (seeded
// from the task's dueAt), not date-only midnights, so zoning the key is a
// straight substitution rather than a shift of the occurrence frame.
//
// Grid geometry is computed on the keys themselves (shiftDay), never by adding
// 86_400_000 ms: a DST day is 23 or 25 hours, so instant arithmetic would skip
// or repeat a cell on the weeks containing a transition.

// Weekday index for a day key, Monday = 0. Pure calendar math on the key's own
// parts -- Date.UTC here is not a timezone claim.
function weekdayOf(dayKey: string): number {
	const [y, m, d] = dayKey.split("-").map(Number);
	return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function dayOfMonth(dayKey: string): number {
	return Number(dayKey.slice(8, 10));
}

function monthOf(dayKey: string): number {
	return Number(dayKey.slice(5, 7));
}

type DayItem = { entry: ViewEntry; occurrence: boolean };

// Same rule as weekdayNames: built per call. Formats the key's PARTS through a
// local Date -- passing the key to `new Date()` would parse it as UTC midnight
// and render the previous day anywhere west of UTC, which is the bug this file
// is fixing.
function longDate(dayKey: string): string {
	const [y, m, d] = dayKey.split("-").map(Number);
	return new Intl.DateTimeFormat(getLocale(), {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
	}).format(new Date(y, m - 1, d));
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
			aria-label={
				item.occurrence
					? m.calendar_chip_recurring({ title: task.title })
					: task.title
			}
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
	dayKey,
	inMonth,
	isToday,
	items,
	index,
	activeIdx,
	registerRef,
	onFocusDay,
	onOpen,
}: {
	dayKey: string;
	inMonth: boolean;
	isToday: boolean;
	items: DayItem[];
	index: number;
	activeIdx: number;
	registerRef: (i: number, el: HTMLButtonElement | null) => void;
	onFocusDay: (i: number) => void;
	onOpen: (task: Task) => void;
}): JSX.Element {
	const { setNodeRef, isOver } = useDroppable({ id: `day:${dayKey}` });
	const dayNum = dayOfMonth(dayKey);
	const label = isToday
		? m.calendar_day_today({ date: longDate(dayKey) })
		: longDate(dayKey);
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
							dragId={`chip:${it.entry.task.id}:${dayKey}`}
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
			<EmptyState
				data-testid="calendar-agenda-empty"
				icon={CalendarClock}
				message={m.calendar_agenda_empty()}
			/>
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
											? m.calendar_chip_recurring({
													title: it.entry.task.title,
												})
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
	timeZone,
}: {
	entries: ViewEntry[];
	isDesktop: boolean;
	onOpenTask: (task: Task) => void;
	onReschedule: (taskId: string, dueAt: number) => void;
	timeZone: string;
}): JSX.Element {
	const today = localDay(new Date(), timeZone);
	// First day of the displayed month, as a day key.
	const [monthKey, setMonthKey] = useState(() => `${today.slice(0, 7)}-01`);
	const [activeIdx, setActiveIdx] = useState(0);
	// changeLocale reloads the page, so locale is constant for this component's
	// lifetime; without the memo DndContext's pointer-move renders would rebuild
	// both formatters on every frame of a drag.
	const weekdays = useMemo(() => weekdayNames(), []);
	const dayRefs = useRef<(HTMLButtonElement | null)[]>([]);
	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
	);

	const taskById = useMemo(
		() => new Map(entries.map((e) => [e.task.id, e.task])),
		[entries],
	);

	const { weeks, monthIndex, gridStartMs, gridEndMs } = useMemo(() => {
		const lead = weekdayOf(monthKey); // days before the 1st (Mon start)
		const start = shiftDay(monthKey, -lead);
		const cells = Array.from({ length: 42 }, (_, i) => shiftDay(start, i));
		const rows: string[][] = [];
		for (let w = 0; w < 6; w++) rows.push(cells.slice(w * 7, w * 7 + 7));
		return {
			weeks: rows,
			monthIndex: monthOf(monthKey),
			// Occurrence expansion still needs instants: the grid's first local
			// midnight through the first local midnight past its last cell.
			gridStartMs: wallClockToInstant(start, "00:00", timeZone).getTime(),
			gridEndMs: wallClockToInstant(
				shiftDay(start, 42),
				"00:00",
				timeZone,
			).getTime(),
		};
	}, [monthKey, timeZone]);

	const monthLabel = new Intl.DateTimeFormat(getLocale(), {
		month: "long",
		year: "numeric",
	}).format(new Date(Number(monthKey.slice(0, 4)), monthIndex - 1, 1));

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
					push(localDay(d, timeZone), { entry, occurrence: true });
			} else if (task.dueAt != null) {
				push(localDay(new Date(task.dueAt), timeZone), {
					entry,
					occurrence: false,
				});
			}
		}
		return map;
	}, [entries, gridStartMs, gridEndMs, timeZone]);

	const agendaGroups = useMemo(
		() =>
			[...byDate.keys()].sort().map((key) => ({
				key,
				label: longDate(key),
				items: byDate.get(key) ?? [],
			})),
		[byDate],
	);

	function shiftMonth(delta: number) {
		const year = Number(monthKey.slice(0, 4));
		const next = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
		setMonthKey(next.toISOString().slice(0, 10));
		setActiveIdx(0);
	}

	function reschedule(taskId: string, targetKey: string) {
		const task = taskById.get(taskId);
		if (!task) return;
		// Preserve the task's LOCAL time-of-day, then re-resolve it against the
		// target day: carrying a raw ms offset across a DST boundary would move a
		// 09:00 task to 08:00 or 10:00. An all-day (or undated) task lands at local
		// midnight and stays all-day (dueAllDay is left untouched).
		const time =
			task.dueAt != null && !task.dueAllDay
				? instantToWallClock(new Date(task.dueAt), timeZone).time
				: "00:00";
		onReschedule(
			taskId,
			wallClockToInstant(targetKey, time, timeZone).getTime(),
		);
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
					{m.calendar_viewing_as_agenda()}
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
						aria-label={m.calendar_prev_month()}
						onClick={() => shiftMonth(-1)}
						className="flex size-7 items-center justify-center rounded border border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					>
						<ChevronLeft className="size-4" />
					</button>
					<button
						type="button"
						data-testid="calendar-next"
						aria-label={m.calendar_next_month()}
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
							{weekdays.map((w) => (
								<th
									key={w.key}
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
							<tr key={week[0]}>
								{week.map((key, di) => {
									return (
										<DayCell
											key={key}
											dayKey={key}
											inMonth={monthOf(key) === monthIndex}
											isToday={key === today}
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
			<section aria-label={m.calendar_agenda_heading()}>
				<h3 className="mb-2 text-xs font-medium text-muted-foreground">
					{m.calendar_agenda_heading()}
				</h3>
				{agenda}
			</section>
		</div>
	);
}
