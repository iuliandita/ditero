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
import { type JSX, useId, useMemo, useRef, useState } from "react";
import { checkShapeFor } from "@/lib/check-shape";
import { priorityLabel } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { localDay, shiftDay } from "../../../domain/local-day.ts";
import { projectRecurrence } from "../../../domain/recurrence.ts";
import {
	instantToWallClock,
	wallClockToInstant,
} from "../../../domain/zoned.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import type { Task } from "../../../zero/schema.gen.ts";
import { useLocalDay } from "../../hooks/useLocalDay.ts";
import { CompletedBy } from "../list/CompletedBy.tsx";
import { EmptyState } from "../ui/empty-state.tsx";
import { agendaDayKeys } from "./calendar-agenda.ts";
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
// "today" every evening west of UTC. Ordinary schedule projections use real
// instants; virtual habits use viewer-local day keys in a UTC date-only frame.
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

type DayItem = {
	entry: ViewEntry;
	occurrence: boolean;
	status?: "done" | "skipped" | "pending";
};

// The cue is the task checkbox in miniature: round for a task, square for an
// item, ringed in its priority tone and filled once done. It is decoration;
// the accessible name (chipName) carries the same facts in words.
const TONE_RING: Record<number, string> = {
	1: "border-priority-1",
	2: "border-priority-2",
	3: "border-priority-3",
};
const TONE_FILL: Record<number, string> = {
	1: "bg-priority-1",
	2: "bg-priority-2",
	3: "bg-priority-3",
};

function ChipCue({ item }: { item: DayItem }): JSX.Element {
	const { task, kind } = item.entry;
	const p = task.priority ?? 0;
	const done =
		item.status === "done" || ((task.done ?? false) && !item.occurrence);
	return (
		<span
			aria-hidden
			data-testid="calendar-chip-cue"
			className={cn(
				"mt-[3px] size-2.5 shrink-0 border-[1.5px]",
				checkShapeFor(kind) === "round" ? "rounded-full" : "rounded-[2px]",
				TONE_RING[p] ?? "border-control-border",
				done && (TONE_FILL[p] ?? "bg-control-border"),
			)}
		/>
	);
}

// A recurring occurrence has no done state of its own; only the concrete task
// reports completion.
function chipName(item: DayItem): string {
	const task = item.entry.task;
	let name = item.occurrence
		? m.calendar_chip_recurring({ title: task.title })
		: task.title;
	if ((task.priority ?? 0) > 0)
		name = m.calendar_chip_priority({
			name,
			priority: priorityLabel(task.priority),
		});
	if (item.status === "done" || (task.done && !item.occurrence))
		name = m.calendar_chip_done({ name });
	if (item.status === "skipped")
		name = `${name}, ${m.habit_occurrence_skipped()}`;
	return item.entry.sourceContext
		? `${name}, ${item.entry.listTitle}, ${item.entry.sourceContext}`
		: name;
}

function isQuiet(item: DayItem): boolean {
	return (
		item.status === "done" ||
		item.status === "skipped" ||
		((item.entry.task.done ?? false) && !item.occurrence)
	);
}

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
	const completionId = useId();
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
			{...(dragEnabled ? { ...attributes, ...listeners } : {})}
			ref={setNodeRef}
			type="button"
			data-testid="calendar-chip"
			style={style}
			onClick={() => onOpen(task)}
			aria-label={chipName(item)}
			aria-describedby={[
				dragEnabled && attributes["aria-describedby"],
				completionId,
			]
				.filter(Boolean)
				.join(" ")}
			title={chipName(item)}
			className={cn(
				"group/completion flex w-full items-start gap-1 rounded px-1 py-0.5 text-start text-xs",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
				// Occurrences read as "generated" via a dashed border + the repeat
				// glyph, not low-contrast text (keeps AA at this size). Done tasks
				// drop their fill and step back to secondary text.
				item.occurrence
					? "border border-dashed border-border text-foreground"
					: isQuiet(item)
						? "text-muted-foreground"
						: "bg-muted text-foreground",
				dragEnabled && "cursor-grab touch-none",
			)}
		>
			{item.occurrence ? (
				<Repeat className="mt-px size-3 shrink-0" aria-hidden="true" />
			) : (
				<ChipCue item={item} />
			)}
			<span className="min-w-0 break-words">
				<span className={cn("line-clamp-2", isQuiet(item) && "line-through")}>
					{task.title}
				</span>
				<CompletedBy
					task={task}
					done={item.status === "done" || (!item.occurrence && !!task.done)}
					habitDate={
						item.entry.kind === "habits"
							? item.entry.occurrence?.date
							: undefined
					}
					id={completionId}
				/>
			</span>
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
	canDrag,
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
	canDrag: (taskId: string) => boolean;
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
							dragEnabled={canDrag(it.entry.task.id)}
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
	const completionId = useId();
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
									aria-label={chipName(it)}
									aria-describedby={`${completionId}-${g.key}-${it.entry.task.id}`}
									className={cn(
										"group/completion flex min-h-11 w-full items-start gap-2 rounded px-1 py-1.5 text-start text-sm md:min-h-9",
										"focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
										(it.occurrence || isQuiet(it)) && "text-muted-foreground",
									)}
								>
									{it.occurrence ? (
										<Repeat
											className="mt-0.5 size-3.5 shrink-0"
											aria-hidden="true"
										/>
									) : (
										<span className="mt-0.5 flex size-3.5 shrink-0 items-center justify-center">
											<ChipCue item={it} />
										</span>
									)}
									<span className="min-w-0 break-words">
										<span
											className={cn(
												"line-clamp-2",
												isQuiet(it) && "line-through",
											)}
										>
											{it.entry.task.title}
										</span>
										<CompletedBy
											task={it.entry.task}
											done={
												it.status === "done" ||
												(!it.occurrence && !!it.entry.task.done)
											}
											habitDate={
												it.entry.kind === "habits"
													? it.entry.occurrence?.date
													: undefined
											}
											id={`${completionId}-${g.key}-${it.entry.task.id}`}
										/>
										{it.status === "done" && (
											<span className="sr-only">{m.status_done()}</span>
										)}
										{it.status === "skipped" && (
											<span className="block text-xs">
												{m.habit_occurrence_skipped()}
											</span>
										)}
										<span className="mt-0.5 block text-xs text-muted-foreground">
											{it.entry.listTitle}
											{it.entry.sourceContext
												? ` · ${it.entry.sourceContext}`
												: ""}
										</span>
									</span>
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
// due tasks render solid; bounded recurring projections across the visible
// range render lighter/dashed so a rule instance reads as generated.
// The keyboard alternative to drag-reschedule is the task-detail due editor
// (open a chip -> edit due); the grid is a native table, arrow-key navigable.
export function CalendarLayout({
	entries,
	isDesktop,
	onOpenTask,
	onReschedule,
	canDrag,
	timeZone,
	habitOccurrenceOnly = false,
}: {
	entries: ViewEntry[];
	isDesktop: boolean;
	onOpenTask: (task: Task) => void;
	onReschedule: (taskId: string, dueAt: number) => void;
	canDrag: (taskId: string) => boolean;
	timeZone: string;
	habitOccurrenceOnly?: boolean;
}): JSX.Element {
	const today = useLocalDay(timeZone);
	// First day of the displayed month, as a day key.
	const [monthKey, setMonthKey] = useState(() => `${today.slice(0, 7)}-01`);
	const [activeIdx, setActiveIdx] = useState(0);
	const [includeEarlier, setIncludeEarlier] = useState(false);
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

	const { byDate, projectionWarnings } = useMemo(() => {
		const warnings: { entry: ViewEntry; status: "capped" | "needs-start" }[] =
			[];
		const map = new Map<string, DayItem[]>();
		const push = (key: string, item: DayItem) => {
			const bucket = map.get(key);
			if (bucket) {
				if (
					!bucket.some(
						(existing) => existing.entry.task.id === item.entry.task.id,
					)
				)
					bucket.push(item);
			} else map.set(key, [item]);
		};
		const from = new Date(gridStartMs);
		for (const entry of entries) {
			const task = entry.task;
			if (entry.kind === "habits" && habitOccurrenceOnly && entry.occurrence) {
				const occurrence = entry.occurrence;
				if (occurrence.status === "unavailable")
					warnings.push({ entry, status: "capped" });
				if (
					occurrence.date &&
					occurrence.status !== "unavailable" &&
					occurrence.status != null &&
					occurrence.dueAt != null &&
					occurrence.dueAt >= gridStartMs &&
					occurrence.dueAt < gridEndMs
				)
					push(occurrence.date, {
						entry,
						occurrence: true,
						status: occurrence.status,
					});
			} else if (task.rrule) {
				const virtual = entry.kind === "habits";
				const frame = (timestamp: number | null | undefined) =>
					timestamp == null
						? null
						: virtual
							? new Date(`${localDay(new Date(timestamp), timeZone)}T00:00:00Z`)
							: new Date(timestamp);
				try {
					const projected = projectRecurrence(
						{
							rrule: task.rrule,
							relative: task.recurrenceRelative ?? false,
							anchorAt: frame(task.recurrenceAnchorAt),
							dueAt: frame(task.dueAt),
							consumed: task.recurrenceConsumed ?? null,
							exhausted: task.done ?? false,
						},
						virtual ? new Date(`${localDay(from, timeZone)}T00:00:00Z`) : from,
						virtual
							? new Date(
									`${localDay(new Date(gridEndMs - 1), timeZone)}T23:59:59.999Z`,
								)
							: new Date(gridEndMs - 1),
						{ includePast: virtual },
					);
					if (projected.status !== "complete")
						warnings.push({ entry, status: projected.status });
					for (const d of projected.occurrences) {
						const key = virtual
							? d.toISOString().slice(0, 10)
							: localDay(d, timeZone);
						push(key, {
							entry,
							occurrence: true,
							...(virtual &&
							entry.occurrence?.date === key &&
							entry.occurrence.status != null &&
							entry.occurrence.status !== "unavailable"
								? { status: entry.occurrence.status }
								: {}),
						});
					}
				} catch {
					// Keep the month usable, but do not present an invalid schedule as empty.
					warnings.push({ entry, status: "capped" });
				}
			} else if (task.dueAt != null) {
				push(localDay(new Date(task.dueAt), timeZone), {
					entry,
					occurrence: false,
				});
			}
		}
		return { byDate: map, projectionWarnings: warnings };
	}, [entries, gridStartMs, gridEndMs, timeZone, habitOccurrenceOnly]);

	const agendaGroups = useMemo(
		() =>
			[...byDate.keys()].sort().map((key) => ({
				key,
				label:
					key === today
						? m.calendar_day_today({ date: longDate(key) })
						: longDate(key),
				items: byDate.get(key) ?? [],
			})),
		[byDate, today],
	);

	function shiftMonth(delta: number) {
		const year = Number(monthKey.slice(0, 4));
		const next = new Date(Date.UTC(year, monthIndex - 1 + delta, 1));
		setMonthKey(next.toISOString().slice(0, 10));
		setActiveIdx(0);
		setIncludeEarlier(false);
	}

	function reschedule(taskId: string, targetKey: string) {
		if (!canDrag(taskId)) return;
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
		if (!canDrag(taskId)) return;
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

	const incompleteSchedules = projectionWarnings.length > 0 && (
		<ul className="flex flex-col gap-1">
			{projectionWarnings.map(({ entry, status }) => (
				<li key={entry.task.id}>
					<button
						type="button"
						onClick={() => onOpenTask(entry.task)}
						className="min-h-11 text-start text-sm text-muted-foreground underline underline-offset-2"
					>
						<span className="font-medium">{entry.task.title}</span>{" "}
						{status === "needs-start"
							? m.recurrence_projection_needs_start()
							: m.recurrence_projection_capped()}
					</button>
				</li>
			))}
		</ul>
	);
	const agenda = <Agenda groups={agendaGroups} onOpen={onOpenTask} />;
	const monthNavigation = (
		<div className="flex items-center justify-between gap-2">
			<h2 className="text-sm font-medium" aria-live="polite">
				{monthLabel}
			</h2>
			<div className="flex shrink-0 items-center gap-1">
				<button
					type="button"
					data-testid="calendar-today"
					onClick={() => {
						setMonthKey(`${today.slice(0, 7)}-01`);
						setIncludeEarlier(false);
						setActiveIdx(0);
					}}
					className="min-h-11 rounded px-2 text-xs font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:min-h-7"
				>
					{m.calendar_go_today()}
				</button>
				<button
					type="button"
					data-testid="calendar-prev"
					aria-label={m.calendar_prev_month()}
					onClick={() => shiftMonth(-1)}
					className="flex size-11 items-center justify-center rounded border border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:size-7"
				>
					<ChevronLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
				</button>
				<button
					type="button"
					data-testid="calendar-next"
					aria-label={m.calendar_next_month()}
					onClick={() => shiftMonth(1)}
					className="flex size-11 items-center justify-center rounded border border-border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:size-7"
				>
					<ChevronRight className="size-4 rtl:rotate-180" aria-hidden="true" />
				</button>
			</div>
		</div>
	);

	if (!isDesktop) {
		const visibleKeys = new Set(
			agendaDayKeys([...byDate.keys()], monthKey, today, includeEarlier),
		);
		const hasEarlier =
			monthKey.slice(0, 7) === today.slice(0, 7) &&
			[...byDate.keys()].some(
				(key) => key.slice(0, 7) === monthKey.slice(0, 7) && key < today,
			);
		return (
			<div data-testid="calendar-surface" className="flex flex-col gap-3">
				{monthNavigation}
				{incompleteSchedules}
				<Agenda
					groups={agendaGroups.filter((g) => visibleKeys.has(g.key))}
					onOpen={onOpenTask}
				/>
				{hasEarlier && (
					<button
						type="button"
						data-testid="calendar-earlier"
						aria-expanded={includeEarlier}
						onClick={() => setIncludeEarlier((value) => !value)}
						className="min-h-11 self-start rounded px-2 text-xs font-medium text-muted-foreground hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					>
						{includeEarlier
							? m.calendar_hide_earlier()
							: m.calendar_show_earlier()}
					</button>
				)}
			</div>
		);
	}

	return (
		<div data-testid="calendar-surface" className="flex flex-col gap-4">
			{monthNavigation}
			{incompleteSchedules}
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
											canDrag={canDrag}
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
