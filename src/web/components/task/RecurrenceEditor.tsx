import { useZero } from "@rocicorp/zero/react";
import { Repeat, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runMutation } from "@/lib/run-mutation";
import { cn } from "@/lib/utils";
import {
	presetToRRule,
	type RecurrencePreset,
	rruleToPreset,
} from "../../../domain/recurrence.ts";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { mutators } from "../../../zero/mutators.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";

type Freq = RecurrencePreset["freq"];

const FREQS: Freq[] = ["daily", "weekly", "monthly", "yearly"];

// Thunks: resolving `m` at module scope would freeze the import-time locale.
const FREQ_LABELS: Record<Freq, () => string> = {
	daily: m.recurrence_freq_daily,
	weekly: m.recurrence_freq_weekly,
	monthly: m.recurrence_freq_monthly,
	yearly: m.recurrence_freq_yearly,
};

const UNIT_LABELS: Record<Freq, (i: { count: number }) => string> = {
	daily: m.recurrence_unit_daily,
	weekly: m.recurrence_unit_weekly,
	monthly: m.recurrence_unit_monthly,
	yearly: m.recurrence_unit_yearly,
};

// 0=Mon .. 6=Sun, matching the domain preset weekday encoding; CLDR names so
// every locale works without a translation pass.
function weekdayNames(): string[] {
	// timeZone stays pinned: the references are UTC midnights, so an unpinned
	// formatter shifts the array a day in negative-offset zones -- and callers
	// index it by domain day, so that persists the wrong weekday.
	const fmt = new Intl.DateTimeFormat(getLocale(), {
		weekday: "short",
		timeZone: "UTC",
	});
	// 2024-01-01 was a Monday.
	return Array.from({ length: 7 }, (_, i) =>
		fmt.format(new Date(Date.UTC(2024, 0, 1 + i))),
	);
}

const DEFAULT_PRESET: RecurrencePreset = { freq: "daily", interval: 1 };

// Read the stored rule back into a preset. rruleToPreset throws on a malformed
// string and returns null for a valid-but-non-preset rule; either way we fall
// back to a sensible default rather than crash the detail surface.
function presetFromRrule(rrule: string | null): RecurrencePreset {
	if (!rrule) return DEFAULT_PRESET;
	try {
		return rruleToPreset(rrule) ?? DEFAULT_PRESET;
	} catch {
		return DEFAULT_PRESET;
	}
}

// A preset for a frequency that keeps the per-freq context field valid, seeded
// from the current preset where it carries over (interval, weekdays, monthday).
function presetForFreq(freq: Freq, prev: RecurrencePreset): RecurrencePreset {
	const interval = prev.interval;
	switch (freq) {
		case "daily":
			return { freq, interval };
		case "yearly":
			return { freq, interval };
		case "weekly":
			return {
				freq,
				interval,
				weekdays: prev.freq === "weekly" ? prev.weekdays : [0],
			};
		case "monthly":
			return {
				freq,
				interval,
				monthday: prev.freq === "monthly" ? prev.monthday : 1,
			};
	}
}

function unitLabel(p: RecurrencePreset): string {
	return UNIT_LABELS[p.freq]({ count: p.interval });
}

function describePreset(p: RecurrencePreset, weekdays: string[]): string {
	switch (p.freq) {
		case "daily":
			return m.recurrence_summary_daily({ count: p.interval });
		case "weekly":
			return m.recurrence_summary_weekly({
				count: p.interval,
				days: [...p.weekdays]
					.sort((a, b) => a - b)
					.map((d) => weekdays[d])
					.join(", "),
			});
		case "monthly":
			return m.recurrence_summary_monthly({
				count: p.interval,
				monthday: p.monthday,
			});
		case "yearly":
			return m.recurrence_summary_yearly({ count: p.interval });
	}
}

// Preset-driven recurrence control (M2 shell doc 1). The raw RRULE is never
// edited: the block serializes a preset via presetToRRule and persists through
// task.update. Mounted in the task detail surface; keyed by task id upstream so
// state resets when the detail switches tasks.
export function RecurrenceEditor({ task }: { task: Task }) {
	const zero = useZero<typeof schema>();
	const [error, setError] = useState<string | null>(null);
	const [enabled, setEnabled] = useState(task.rrule != null);
	const [preset, setPreset] = useState<RecurrencePreset>(
		presetFromRrule(task.rrule ?? null),
	);
	const [relative, setRelative] = useState(task.recurrenceRelative ?? false);
	const [reminder, setReminder] = useState(task.reminderTime ?? "");

	function persist(next: {
		preset?: RecurrencePreset;
		relative?: boolean;
		reminder?: string;
	}) {
		setError(null);
		const p = next.preset ?? preset;
		const rel = next.relative ?? relative;
		const rem = next.reminder ?? reminder;
		let rrule: string;
		try {
			rrule = presetToRRule(p);
		} catch (e) {
			setError(e instanceof Error ? e.message : m.recurrence_invalid());
			return;
		}
		void runMutation(
			zero.mutate(
				mutators.task.update({
					id: task.id,
					rrule,
					recurrenceRelative: rel,
					reminderTime: rem === "" ? null : rem,
				}),
			),
			setError,
		);
	}

	function enable() {
		setEnabled(true);
		persist({});
	}

	function clear() {
		setEnabled(false);
		setError(null);
		void runMutation(
			zero.mutate(
				mutators.task.update({
					id: task.id,
					rrule: null,
					reminderTime: null,
				}),
			),
			setError,
		);
	}

	function setFreq(freq: Freq) {
		const next = presetForFreq(freq, preset);
		setPreset(next);
		persist({ preset: next });
	}

	function setInterval(value: number) {
		if (!Number.isInteger(value) || value < 1) return;
		const next = { ...preset, interval: value };
		setPreset(next);
		persist({ preset: next });
	}

	function toggleWeekday(day: number) {
		if (preset.freq !== "weekly") return;
		const has = preset.weekdays.includes(day);
		// Keep at least one weekday selected so the rule stays serializable.
		if (has && preset.weekdays.length === 1) return;
		const weekdays = has
			? preset.weekdays.filter((d) => d !== day)
			: [...preset.weekdays, day];
		const next: RecurrencePreset = { ...preset, weekdays };
		setPreset(next);
		persist({ preset: next });
	}

	function setMonthday(value: number) {
		if (preset.freq !== "monthly") return;
		if (!Number.isInteger(value) || value < 1 || value > 31) return;
		const next: RecurrencePreset = { ...preset, monthday: value };
		setPreset(next);
		persist({ preset: next });
	}

	function toggleRelative() {
		const next = !relative;
		setRelative(next);
		persist({ relative: next });
	}

	function commitReminder(value: string) {
		setReminder(value);
		// Only persist a complete HH:MM value or a cleared field; a partial entry
		// would fail the mutator's format guard.
		if (value === "" || /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
			persist({ reminder: value });
		}
	}

	if (!enabled) {
		return (
			<div className="flex flex-col gap-1 text-sm">
				<span className="text-muted-foreground">{m.recurrence_repeat()}</span>
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					data-testid="recurrence-enable"
					onClick={enable}
				>
					<Repeat /> {m.recurrence_does_not_repeat()}
				</Button>
			</div>
		);
	}

	const weekdays = weekdayNames();

	return (
		<div
			className="flex flex-col gap-3 text-sm"
			data-testid="recurrence-editor"
		>
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground">{m.recurrence_repeat()}</span>
				<Button
					variant="ghost"
					size="sm"
					data-testid="recurrence-clear"
					aria-label={m.recurrence_does_not_repeat()}
					onClick={clear}
				>
					<X /> {m.recurrence_clear()}
				</Button>
			</div>

			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}

			<fieldset
				aria-label={m.recurrence_frequency()}
				className="flex gap-1.5 border-0 p-0"
				data-testid="recurrence-freq"
			>
				{FREQS.map((freq) => {
					const active = preset.freq === freq;
					return (
						<button
							key={freq}
							type="button"
							aria-pressed={active}
							data-testid={`recurrence-freq-${freq}`}
							onClick={() => setFreq(freq)}
							className={cn(
								"flex-1 rounded-lg border px-2 py-1 text-sm transition-colors motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
								active
									? "border-ring bg-muted font-medium"
									: "text-muted-foreground",
							)}
						>
							{FREQ_LABELS[freq]()}
						</button>
					);
				})}
			</fieldset>

			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">{m.recurrence_every()}</span>
				<Input
					type="number"
					min={1}
					step={1}
					value={preset.interval}
					aria-label={m.recurrence_interval()}
					data-testid="recurrence-interval"
					className="h-8 w-20"
					onChange={(e) => setInterval(e.target.valueAsNumber)}
				/>
				<span className="text-muted-foreground">{unitLabel(preset)}</span>
			</div>

			{preset.freq === "weekly" && (
				<fieldset
					aria-label={m.recurrence_weekdays()}
					className="flex flex-wrap gap-1.5 border-0 p-0"
					data-testid="recurrence-weekdays"
				>
					{weekdays.map((label, day) => {
						const active = preset.weekdays.includes(day);
						return (
							<button
								key={label}
								type="button"
								aria-pressed={active}
								aria-label={label}
								data-testid={`recurrence-weekday-${day}`}
								onClick={() => toggleWeekday(day)}
								className={cn(
									"h-8 w-11 rounded-lg border text-sm transition-colors motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
									active
										? "border-ring bg-muted font-medium"
										: "text-muted-foreground",
								)}
							>
								{label}
							</button>
						);
					})}
				</fieldset>
			)}

			{preset.freq === "monthly" && (
				<div className="flex items-center gap-2">
					<span className="text-muted-foreground">{m.recurrence_on_day()}</span>
					<Input
						type="number"
						min={1}
						max={31}
						step={1}
						value={preset.monthday}
						aria-label={m.recurrence_day_of_month()}
						data-testid="recurrence-monthday"
						className="h-8 w-20"
						onChange={(e) => setMonthday(e.target.valueAsNumber)}
					/>
				</div>
			)}

			<button
				type="button"
				aria-pressed={relative}
				data-testid="recurrence-relative"
				onClick={toggleRelative}
				className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-start transition-colors motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
			>
				<span className="flex flex-col">
					<span>
						{relative
							? m.recurrence_relative_on()
							: m.recurrence_relative_off()}
					</span>
					<span className="text-xs text-muted-foreground">
						{relative
							? m.recurrence_relative_on_hint()
							: m.recurrence_relative_off_hint()}
					</span>
				</span>
				<span
					aria-hidden
					className={cn(
						"relative h-5 w-9 shrink-0 rounded-full transition-colors motion-reduce:transition-none",
						relative ? "bg-primary" : "bg-input",
					)}
				>
					<span
						className={cn(
							"absolute top-0.5 size-4 rounded-full bg-background transition-transform motion-reduce:transition-none",
							relative ? "translate-x-4" : "translate-x-0.5",
						)}
					/>
				</span>
			</button>

			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">{m.reminder_time()}</span>
				<Input
					type="time"
					value={reminder}
					aria-label={m.reminder_time()}
					data-testid="recurrence-reminder"
					className="h-8 w-32"
					onChange={(e) => commitReminder(e.target.value)}
				/>
				{reminder !== "" && (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={m.reminder_time_clear()}
						onClick={() => commitReminder("")}
					>
						<X />
					</Button>
				)}
			</div>

			<p
				className="text-sm text-muted-foreground"
				data-testid="recurrence-summary"
			>
				{describePreset(preset, weekdays)}
			</p>
		</div>
	);
}
