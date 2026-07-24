import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { clampFocusConfig, type FocusConfig } from "../../focus/timer-core.ts";
import { useUserPref } from "../../hooks/useUserPref.ts";

// Minute/round fields for the pomodoro config. `max` mirrors the mutator caps so
// the UI never offers an out-of-range value; the write is re-clamped anyway.
// `label` is a getter: this array is module-level, so resolving the message
// eagerly would freeze it at the import-time locale.
const MIN_FIELDS: {
	key: "workMin" | "breakMin" | "longBreakMin";
	label: string;
	testid: string;
}[] = [
	{
		key: "workMin",
		get label() {
			return m.focus_field_work_min();
		},
		testid: "focus-work-min",
	},
	{
		key: "breakMin",
		get label() {
			return m.focus_field_break_min();
		},
		testid: "focus-break-min",
	},
	{
		key: "longBreakMin",
		get label() {
			return m.focus_field_long_break_min();
		},
		testid: "focus-longbreak-min",
	},
];

export function FocusSettings() {
	const { pref, setPref } = useUserPref();
	const focus = pref.focus;

	// Re-clamp the whole config on every write so a stored value can never drift
	// past the caps, matching the server-side validation.
	function write(patch: Partial<FocusConfig>) {
		setPref({ focus: clampFocusConfig({ ...focus, ...patch }) });
	}

	return (
		<section className="mt-8 border-t pt-4" aria-labelledby="focus-heading">
			<h2 id="focus-heading" className="text-sm font-semibold">
				{m.focus_settings_heading()}
			</h2>
			<p className="mt-1 text-xs text-muted-foreground">
				{m.focus_settings_description()}
			</p>

			<div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
				{MIN_FIELDS.map((f) => (
					<label key={f.key} className="flex flex-col gap-1 text-sm">
						<span className="text-muted-foreground">{f.label}</span>
						<input
							type="number"
							min={1}
							max={180}
							value={focus[f.key]}
							data-testid={f.testid}
							className="h-8 rounded-lg border bg-transparent px-2 text-sm"
							onChange={(e) => write({ [f.key]: e.target.valueAsNumber })}
						/>
					</label>
				))}
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">
						{m.focus_field_rounds()}
					</span>
					<input
						type="number"
						min={1}
						max={12}
						value={focus.roundsPerLongBreak}
						data-testid="focus-rounds"
						className="h-8 rounded-lg border bg-transparent px-2 text-sm"
						onChange={(e) =>
							write({ roundsPerLongBreak: e.target.valueAsNumber })
						}
					/>
				</label>
			</div>

			<div className="mt-4 flex items-center justify-between gap-4">
				<span className="text-sm">{m.focus_autocycle_label()}</span>
				<Button
					size="sm"
					variant={focus.autoCycle ? "default" : "outline"}
					role="switch"
					aria-checked={focus.autoCycle}
					data-testid="focus-autocycle"
					onClick={() => write({ autoCycle: !focus.autoCycle })}
				>
					{focus.autoCycle ? m.toggle_on() : m.toggle_off()}
				</Button>
			</div>
		</section>
	);
}
