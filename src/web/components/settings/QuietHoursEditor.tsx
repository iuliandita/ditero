import { m } from "../../../paraglide/messages.js";
import { useUserPref } from "../../hooks/useUserPref.ts";

const DEFAULT_QUIET = { start: "22:00", end: "07:00" };

// Quiet hours + the read-only timezone line (shell doc 2). The zone is not
// editable here: user_pref.timezone is a general-purpose pref this page reads,
// and a wrong zone silently mistimes every reminder, so it is stated rather
// than hidden.
export function QuietHoursEditor() {
	const { pref, setPref, timezoneDetected } = useUserPref();
	const quiet = pref.quietHours;
	const equal = quiet != null && quiet.start === quiet.end;

	// Equal start/end is written through and rejected server-side; the warning
	// below explains it rather than the field silently reverting.
	function set(patch: Partial<{ start: string; end: string }>) {
		setPref({ quietHours: { ...(quiet ?? DEFAULT_QUIET), ...patch } });
	}

	return (
		<div data-testid="quiet-hours">
			<div className="flex flex-wrap items-end gap-3">
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">
						{m.quiet_hours_start_label()}
					</span>
					<input
						type="time"
						value={quiet?.start ?? ""}
						aria-label={m.quiet_hours_start_aria()}
						data-testid="quiet-start"
						aria-describedby="quiet-hours-note"
						className="h-8 rounded-lg border bg-transparent px-2 text-sm"
						onChange={(e) => set({ start: e.target.value })}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">
						{m.quiet_hours_end_label()}
					</span>
					<input
						type="time"
						value={quiet?.end ?? ""}
						aria-label={m.quiet_hours_end_aria()}
						data-testid="quiet-end"
						aria-describedby="quiet-hours-note"
						className="h-8 rounded-lg border bg-transparent px-2 text-sm"
						onChange={(e) => set({ end: e.target.value })}
					/>
				</label>
				{quiet && (
					<button
						type="button"
						data-testid="quiet-clear"
						className="h-8 rounded-lg border px-2 text-sm"
						onClick={() => setPref({ quietHours: null })}
					>
						{m.quiet_hours_clear()}
					</button>
				)}
			</div>

			<p className="mt-2 text-xs text-muted-foreground" data-testid="quiet-tz">
				{timezoneDetected
					? m.quiet_hours_timezone_detected({ timezone: pref.timezone })
					: m.quiet_hours_timezone({ timezone: pref.timezone })}
			</p>

			{equal && (
				<p
					role="alert"
					data-testid="quiet-equal-warning"
					className="mt-2 text-xs text-destructive"
				>
					{m.quiet_hours_equal_warning()}
				</p>
			)}

			<p
				id="quiet-hours-note"
				className="mt-2 text-xs text-muted-foreground"
				data-testid="quiet-urgent-note"
			>
				{m.quiet_hours_urgent_note()}
			</p>
		</div>
	);
}
