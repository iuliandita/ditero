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
import { mutators } from "../../../zero/mutators.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";

type Freq = RecurrencePreset["freq"];

const FREQS: { value: Freq; label: string }[] = [
	{ value: "daily", label: "Daily" },
	{ value: "weekly", label: "Weekly" },
	{ value: "monthly", label: "Monthly" },
	{ value: "yearly", label: "Yearly" },
];

// 0=Mon .. 6=Sun, matching the domain preset weekday encoding.
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
	const plural = p.interval !== 1;
	switch (p.freq) {
		case "daily":
			return plural ? "days" : "day";
		case "weekly":
			return plural ? "weeks" : "week";
		case "monthly":
			return plural ? "months" : "month";
		case "yearly":
			return plural ? "years" : "year";
	}
}

function describePreset(p: RecurrencePreset): string {
	const every = p.interval === 1 ? "Every" : `Every ${p.interval}`;
	switch (p.freq) {
		case "daily":
			return p.interval === 1 ? "Every day" : `${every} days`;
		case "weekly": {
			const days = [...p.weekdays]
				.sort((a, b) => a - b)
				.map((d) => WEEKDAYS[d])
				.join(", ");
			const unit = p.interval === 1 ? "week" : "weeks";
			return `${every} ${unit} on ${days}`;
		}
		case "monthly": {
			const unit = p.interval === 1 ? "month" : "months";
			return `${every} ${unit} on day ${p.monthday}`;
		}
		case "yearly":
			return p.interval === 1 ? "Every year" : `${every} years`;
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
			setError(e instanceof Error ? e.message : "Invalid recurrence.");
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
				<span className="text-muted-foreground">Repeat</span>
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					data-testid="recurrence-enable"
					onClick={enable}
				>
					<Repeat /> Does not repeat
				</Button>
			</div>
		);
	}

	return (
		<div
			className="flex flex-col gap-3 text-sm"
			data-testid="recurrence-editor"
		>
			<div className="flex items-center justify-between">
				<span className="text-muted-foreground">Repeat</span>
				<Button
					variant="ghost"
					size="sm"
					data-testid="recurrence-clear"
					aria-label="Does not repeat"
					onClick={clear}
				>
					<X /> Don't repeat
				</Button>
			</div>

			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}

			<fieldset
				aria-label="Frequency"
				className="flex gap-1.5 border-0 p-0"
				data-testid="recurrence-freq"
			>
				{FREQS.map((f) => {
					const active = preset.freq === f.value;
					return (
						<button
							key={f.value}
							type="button"
							aria-pressed={active}
							data-testid={`recurrence-freq-${f.value}`}
							onClick={() => setFreq(f.value)}
							className={cn(
								"flex-1 rounded-lg border px-2 py-1 text-sm transition-colors motion-reduce:transition-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
								active
									? "border-ring bg-muted font-medium"
									: "text-muted-foreground",
							)}
						>
							{f.label}
						</button>
					);
				})}
			</fieldset>

			<div className="flex items-center gap-2">
				<span className="text-muted-foreground">Every</span>
				<Input
					type="number"
					min={1}
					step={1}
					value={preset.interval}
					aria-label="Interval"
					data-testid="recurrence-interval"
					className="h-8 w-20"
					onChange={(e) => setInterval(e.target.valueAsNumber)}
				/>
				<span className="text-muted-foreground">{unitLabel(preset)}</span>
			</div>

			{preset.freq === "weekly" && (
				<fieldset
					aria-label="Weekdays"
					className="flex flex-wrap gap-1.5 border-0 p-0"
					data-testid="recurrence-weekdays"
				>
					{WEEKDAYS.map((label, day) => {
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
					<span className="text-muted-foreground">On day</span>
					<Input
						type="number"
						min={1}
						max={31}
						step={1}
						value={preset.monthday}
						aria-label="Day of month"
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
					<span>{relative ? "After I complete it" : "On schedule"}</span>
					<span className="text-xs text-muted-foreground">
						{relative
							? "Next due counts from completion"
							: "Next due follows the fixed schedule"}
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
				<span className="text-muted-foreground">Reminder time</span>
				<Input
					type="time"
					value={reminder}
					aria-label="Reminder time"
					data-testid="recurrence-reminder"
					className="h-8 w-32"
					onChange={(e) => commitReminder(e.target.value)}
				/>
				{reminder !== "" && (
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Clear reminder time"
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
				{describePreset(preset)}
			</p>
		</div>
	);
}
