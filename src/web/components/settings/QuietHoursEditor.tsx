import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "../../../paraglide/messages.js";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { timeZoneLabel } from "../../lib/time-zones.ts";
import { TimeField } from "../task/TimeField.tsx";
import { jumpToSettingsSection } from "./SettingsNav.tsx";
import { TIMEZONE_TRIGGER_ID } from "./TimeZoneSetting.tsx";

const DEFAULT_QUIET = { start: "22:00", end: "07:00" };

// Quiet hours + the timezone line (shell doc 2). Times are stored as wall
// clock HH:MM and the server reads them in user_pref.timezone
// (domain/quiet-hours.ts), so they are shown and typed as-is, with the zone
// beside them. The zone is edited under Appearance and language; a wrong zone
// silently mistimes every reminder, so it is stated rather than hidden.
export function QuietHoursEditor() {
	const { pref, setPref, timezoneDetected } = useUserPref();
	const quiet = pref.quietHours;
	const equal = quiet != null && quiet.start === quiet.end;
	const saveSequence = useRef(0);
	const [saveState, setSaveState] = useState<
		"idle" | "saving" | "saved" | "error"
	>("idle");

	function save(quietHours: typeof quiet) {
		const sequence = ++saveSequence.current;
		setSaveState("saving");
		void setPref({ quietHours }).then((succeeded) => {
			if (sequence === saveSequence.current) {
				setSaveState(succeeded ? "saved" : "error");
			}
		});
	}

	// Equal start/end is written through and rejected server-side; the warning
	// below explains it rather than the field silently reverting.
	// An empty field is not a way to clear quiet hours (Clear is); it keeps
	// the other bound and fills this one from the default window.
	function commit(patch: Partial<{ start: string; end: string }>) {
		const next = { ...(quiet ?? DEFAULT_QUIET), ...patch };
		if (next.start === "") next.start = quiet?.start ?? DEFAULT_QUIET.start;
		if (next.end === "") next.end = quiet?.end ?? DEFAULT_QUIET.end;
		save(next);
	}

	return (
		<div data-testid="quiet-hours">
			<div className="flex flex-wrap items-end gap-3">
				<div className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground" aria-hidden="true">
						{m.quiet_hours_start_label()}
					</span>
					<TimeField
						value={quiet?.start ?? ""}
						label={m.quiet_hours_start_aria()}
						data-testid="quiet-start"
						onCommit={(start) => commit({ start })}
					/>
				</div>
				<div className="flex flex-col gap-1 text-sm">
					<span className="text-muted-foreground" aria-hidden="true">
						{m.quiet_hours_end_label()}
					</span>
					<TimeField
						value={quiet?.end ?? ""}
						label={m.quiet_hours_end_aria()}
						data-testid="quiet-end"
						onCommit={(end) => commit({ end })}
					/>
				</div>
				<span
					className="flex h-8 items-center text-sm text-muted-foreground pointer-coarse:h-11"
					data-testid="quiet-zone"
				>
					{timeZoneLabel(pref.timezone)}
				</span>
				{quiet && (
					<Button
						variant="ghost"
						data-testid="quiet-clear"
						className="pointer-coarse:h-11"
						onClick={() => save(null)}
					>
						{m.quiet_hours_clear()}
					</Button>
				)}
			</div>

			<p className="mt-2 text-xs text-muted-foreground" data-testid="quiet-tz">
				{timezoneDetected
					? m.quiet_hours_timezone_detected({
							timezone: timeZoneLabel(pref.timezone),
						})
					: m.quiet_hours_timezone({
							timezone: timeZoneLabel(pref.timezone),
						})}{" "}
				<Button
					variant="link"
					data-testid="quiet-tz-change"
					className="h-auto p-0 text-xs"
					onClick={() => {
						jumpToSettingsSection("appearance");
						document.getElementById(TIMEZONE_TRIGGER_ID)?.focus();
					}}
				>
					{m.settings_timezone_change()}
				</Button>
			</p>

			{saveState !== "idle" && (
				<p
					role={saveState === "error" ? "alert" : "status"}
					data-testid="quiet-save-status"
					className={`mt-2 text-xs ${
						saveState === "error" ? "text-destructive" : "text-muted-foreground"
					}`}
				>
					{saveState === "saving"
						? m.quiet_hours_saving()
						: saveState === "saved"
							? m.quiet_hours_saved()
							: m.mutation_failed()}
				</p>
			)}

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
