import {
	CalendarDays,
	CalendarRange,
	CalendarX,
	ChevronLeft,
	ChevronRight,
	Sunrise,
	X,
} from "lucide-react";
import {
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { dueToInputs, formatDue, isOverdue } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { dateParserFor } from "../../../domain/quick-add.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import {
	addDays,
	dayKey,
	firstWeekday,
	monthCells,
	nextWeekStart,
	parseDayKey,
	parseDueText,
	sameDay,
	startOfDay,
	weekdayNames,
} from "../../lib/date-picker.ts";
import { TimeField } from "./TimeField.tsx";

function browserLanguages(): readonly string[] {
	return typeof navigator === "undefined" ? [] : navigator.languages;
}

/**
 * Due date + time for the task detail. The date is a popover (typed date,
 * quick picks, month grid); the time is a typed field beside it that only
 * exists once there is a date. Both write through `onSet(date, time)` with the
 * same `YYYY-MM-DD` / `HH:MM` pair `inputsToDue` has always taken, so storage
 * is unchanged: no time means all-day at local midnight.
 */
export function DuePicker({
	dueAt,
	dueAllDay,
	done,
	disabled = false,
	onSet,
	onClear,
	children,
}: {
	dueAt: number | null;
	dueAllDay: boolean | null;
	done: boolean;
	disabled?: boolean;
	onSet: (date: string, time: string) => void;
	onClear: () => void;
	/** Rendered at the end of the row (the reminder chip). */
	children?: React.ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const due = dueToInputs(dueAt);
	// dueToInputs renders an all-day due as local midnight; carrying that
	// "00:00" into a date change would silently turn it into a timed task.
	const time = dueAt == null || dueAllDay ? "" : due.time;
	const overdue = isOverdue({ done, dueAt, dueAllDay });
	const shown = dueAt != null ? formatDue(dueAt, true) : m.task_due_add();

	function pick(date: string, typedTime: string | null = null) {
		onSet(date, typedTime ?? time);
		setOpen(false);
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Popover open={open} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<Button
						disabled={disabled}
						variant="outline"
						size="sm"
						data-testid="due-picker"
						aria-label={m.task_due_trigger_aria({ value: shown })}
						className={cn(
							"pointer-coarse:h-11",
							dueAt == null && "text-muted-foreground",
							overdue && "text-destructive",
						)}
					>
						<CalendarDays />
						{shown}
					</Button>
				</PopoverTrigger>
				<PopoverContent
					align="start"
					className="w-72 gap-2 p-2 pointer-coarse:w-[21rem]"
					data-testid="due-picker-content"
					aria-label={m.schedule_pick_date()}
					onOpenAutoFocus={(e) => {
						// A touch keyboard popping over the calendar is worse than no
						// focus; pointer users land in the typed field.
						if (window.matchMedia("(pointer: coarse)").matches)
							e.preventDefault();
					}}
				>
					<TypedDate onPick={pick} />
					<QuickPicks
						hasDue={dueAt != null}
						onPick={pick}
						onClear={() => {
							onClear();
							setOpen(false);
						}}
					/>
					<MonthGrid
						selected={parseDayKey(due.date)}
						onPick={(d) => pick(dayKey(d))}
					/>
				</PopoverContent>
			</Popover>
			{dueAt != null && (
				<>
					<TimeField
						disabled={disabled}
						value={time}
						label={m.task_due_time_aria()}
						data-testid="due-time"
						onCommit={(next) => onSet(due.date, next)}
					/>
					<Button
						disabled={disabled}
						variant="ghost"
						size="icon-sm"
						aria-label={m.task_due_clear()}
						onClick={onClear}
					>
						<X />
					</Button>
				</>
			)}
			{children}
		</div>
	);
}

export function TypedDate({
	onPick,
	label = m.task_due_date_aria(),
}: {
	onPick: (date: string, time: string | null) => void;
	label?: string;
}) {
	const locale = getLocale();
	const [text, setText] = useState("");
	const [invalid, setInvalid] = useState(false);
	const errorId = useId();
	return (
		<div className="flex flex-col gap-1">
			<Input
				value={text}
				aria-label={label}
				aria-invalid={invalid || undefined}
				aria-describedby={invalid ? errorId : undefined}
				placeholder={
					dateParserFor(locale)
						? m.task_due_type_placeholder()
						: m.task_due_type_placeholder_iso()
				}
				autoComplete="off"
				data-testid="due-picker-input"
				onChange={(e) => {
					setText(e.target.value);
					setInvalid(false);
				}}
				onKeyDown={(e) => {
					if (e.key !== "Enter") return;
					e.preventDefault();
					const parsed = parseDueText(text, locale);
					if (!parsed) {
						setInvalid(true);
						return;
					}
					onPick(parsed.date, parsed.time);
				}}
			/>
			{invalid && (
				<span id={errorId} className="px-1 text-xs text-destructive">
					{m.task_due_type_invalid()}
				</span>
			)}
		</div>
	);
}

export function QuickPicks({
	hasDue,
	onPick,
	onClear,
}: {
	hasDue: boolean;
	onPick: (date: string) => void;
	onClear: () => void;
}) {
	const locale = getLocale();
	const today = startOfDay(new Date());
	const first = firstWeekday(locale, browserLanguages());
	const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
	const picks = [
		{ id: "today", icon: CalendarDays, label: m.due_today(), date: today },
		{
			id: "tomorrow",
			icon: Sunrise,
			label: m.due_tomorrow(),
			date: addDays(today, 1),
		},
		{
			id: "next-week",
			icon: CalendarRange,
			label: m.task_due_next_week(),
			date: nextWeekStart(today, first),
		},
	];
	const row =
		"flex h-8 w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none pointer-coarse:h-11 [&_svg]:size-4 [&_svg]:text-muted-foreground";
	return (
		<ul className="flex flex-col border-y py-1">
			{picks.map((p) => (
				<li key={p.id}>
					<button
						type="button"
						data-testid={`due-pick-${p.id}`}
						className={row}
						onClick={() => onPick(dayKey(p.date))}
					>
						<p.icon aria-hidden />
						<span className="flex-1">{p.label}</span>
						<span className="text-xs text-muted-foreground">
							{weekday.format(p.date)}
						</span>
					</button>
				</li>
			))}
			{hasDue && (
				<li>
					<button
						type="button"
						data-testid="due-pick-none"
						className={row}
						onClick={onClear}
					>
						<CalendarX aria-hidden />
						<span className="flex-1">{m.due_no_date()}</span>
					</button>
				</li>
			)}
		</ul>
	);
}

export function MonthGrid({
	selected,
	onPick,
}: {
	selected: Date | null;
	onPick: (d: Date) => void;
}) {
	const locale = getLocale();
	const first = useMemo(
		() => firstWeekday(locale, browserLanguages()),
		[locale],
	);
	const today = startOfDay(new Date());
	const [active, setActive] = useState<Date>(selected ?? today);
	const [view, setView] = useState({
		year: active.getFullYear(),
		month: active.getMonth(),
	});
	const moveFocus = useRef(false);
	const tableRef = useRef<HTMLTableElement>(null);
	const headingId = useId();

	useEffect(() => {
		if (!moveFocus.current) return;
		moveFocus.current = false;
		tableRef.current
			?.querySelector<HTMLButtonElement>('button[tabindex="0"]')
			?.focus();
	});

	const cells = monthCells(view.year, view.month, first);
	const names = weekdayNames(locale, first);
	const rows = Array.from({ length: cells.length / 7 }, (_, i) =>
		cells.slice(i * 7, i * 7 + 7),
	);
	const inView =
		active.getFullYear() === view.year && active.getMonth() === view.month;
	// Exactly one tab stop in the grid: the active day, or the 1st when paging
	// moved the view away from it.
	const tabStop = inView ? active : new Date(view.year, view.month, 1);
	const monthLabel = new Intl.DateTimeFormat(locale, {
		month: "long",
		year: "numeric",
	}).format(new Date(view.year, view.month, 1));
	const fullDay = new Intl.DateTimeFormat(locale, { dateStyle: "full" });
	const dayNumber = new Intl.DateTimeFormat(locale, { day: "numeric" });

	function focusDay(d: Date) {
		setActive(d);
		setView({ year: d.getFullYear(), month: d.getMonth() });
		moveFocus.current = true;
	}

	function page(delta: number) {
		const next = new Date(view.year, view.month + delta, 1);
		setView({ year: next.getFullYear(), month: next.getMonth() });
	}

	function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
		const rtl = getComputedStyle(e.currentTarget).direction === "rtl";
		const base = tabStop;
		const steps: Record<string, number> = {
			ArrowLeft: rtl ? 1 : -1,
			ArrowRight: rtl ? -1 : 1,
			ArrowUp: -7,
			ArrowDown: 7,
		};
		let next: Date | null = null;
		if (e.key in steps) next = addDays(base, steps[e.key]);
		else if (e.key === "PageUp" || e.key === "PageDown") {
			const delta = e.key === "PageUp" ? -1 : 1;
			const target = new Date(base.getFullYear(), base.getMonth() + delta, 1);
			const last = new Date(
				target.getFullYear(),
				target.getMonth() + 1,
				0,
			).getDate();
			target.setDate(Math.min(base.getDate(), last));
			next = target;
		} else if (e.key === "Home" || e.key === "End") {
			const offset = (base.getDay() - first + 7) % 7;
			next = addDays(base, e.key === "Home" ? -offset : 6 - offset);
		}
		if (next) {
			e.preventDefault();
			focusDay(next);
		}
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between ps-2">
				<span id={headingId} className="text-sm font-medium" aria-live="polite">
					{monthLabel}
				</span>
				<div className="flex">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.calendar_prev_month()}
						onClick={() => page(-1)}
					>
						<ChevronLeft className="rtl:rotate-180" />
					</Button>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.calendar_next_month()}
						onClick={() => page(1)}
					>
						<ChevronRight className="rtl:rotate-180" />
					</Button>
				</div>
			</div>
			<table
				ref={tableRef}
				aria-labelledby={headingId}
				className="w-full border-collapse text-center"
				onKeyDown={onKeyDown}
			>
				<thead>
					<tr>
						{names.map((n) => (
							<th
								key={n.long}
								scope="col"
								abbr={n.long}
								className="pb-1 text-xs font-normal text-muted-foreground"
							>
								{n.short}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{rows.map((week) => (
						<tr key={week.find(Boolean)?.getDate()}>
							{week.map((d, i) =>
								d ? (
									<td key={d.getDate()} className="p-0">
										<button
											type="button"
											tabIndex={sameDay(d, tabStop) ? 0 : -1}
											aria-label={fullDay.format(d)}
											aria-pressed={selected != null && sameDay(d, selected)}
											aria-current={sameDay(d, today) ? "date" : undefined}
											className={cn(
												"mx-auto flex size-9 items-center justify-center rounded-full text-sm tabular-nums transition-colors duration-(--motion-fast) ease-(--motion-ease) hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring motion-reduce:transition-none pointer-coarse:size-11",
												sameDay(d, today) && "font-semibold text-primary",
												selected != null &&
													sameDay(d, selected) &&
													"bg-primary text-primary-foreground hover:bg-primary",
											)}
											onClick={() => onPick(d)}
										>
											{dayNumber.format(d)}
										</button>
									</td>
								) : (
									// biome-ignore lint/suspicious/noArrayIndexKey: padding cells have no identity
									<td key={`pad-${i}`} />
								),
							)}
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
