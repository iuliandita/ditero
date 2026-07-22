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
					<span className="text-muted-foreground">Quiet from</span>
					<input
						type="time"
						value={quiet?.start ?? ""}
						aria-label="Quiet hours start"
						data-testid="quiet-start"
						aria-describedby="quiet-hours-note"
						className="h-8 rounded-lg border bg-transparent px-2 text-sm"
						onChange={(e) => set({ start: e.target.value })}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground">until</span>
					<input
						type="time"
						value={quiet?.end ?? ""}
						aria-label="Quiet hours end"
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
						Clear
					</button>
				)}
			</div>

			<p className="mt-2 text-xs text-muted-foreground" data-testid="quiet-tz">
				{timezoneDetected
					? `Detected as ${pref.timezone} - is this right?`
					: `Times are in ${pref.timezone}.`}
			</p>

			{equal && (
				<p
					role="alert"
					data-testid="quiet-equal-warning"
					className="mt-2 text-xs text-destructive"
				>
					Start and end must differ. To silence every channel instead, turn the
					channel off above.
				</p>
			)}

			<p
				id="quiet-hours-note"
				className="mt-2 text-xs text-muted-foreground"
				data-testid="quiet-urgent-note"
			>
				Reminders marked urgent ignore quiet hours.
			</p>
		</div>
	);
}
