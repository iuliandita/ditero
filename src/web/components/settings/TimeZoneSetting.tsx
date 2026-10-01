import { useId, useMemo } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { m } from "../../../paraglide/messages.js";
import { useUserPref } from "../../hooks/useUserPref.ts";
import { timeZoneLabel, timeZoneOptions } from "../../lib/time-zones.ts";
import { SaveStatus, useSaveStatus } from "./SaveStatus.tsx";

export const TIMEZONE_TRIGGER_ID = "settings-timezone";

// user_pref.timezone is the zone every reminder time and quiet hour is
// interpreted in on the server, so it is set here rather than only detected.
export function TimeZoneSetting() {
	const { pref, setPref } = useUserPref();
	const labelId = useId();
	const helpId = useId();
	const status = useSaveStatus();
	const { zones, selected } = useMemo(
		() => timeZoneOptions(pref.timezone),
		[pref.timezone],
	);

	return (
		<div className="flex flex-col gap-1 text-sm">
			<span id={labelId} className="text-muted-foreground">
				{m.settings_timezone_label()}
			</span>
			<Select
				value={selected}
				onValueChange={(timezone) =>
					status.track(setPref({ timezone, timezoneChosen: true }))
				}
			>
				<SelectTrigger
					id={TIMEZONE_TRIGGER_ID}
					aria-labelledby={labelId}
					aria-describedby={helpId}
					data-testid="timezone-select"
					className="w-full sm:w-56 pointer-coarse:data-[size=default]:h-11"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent position="popper" className="max-h-80">
					{zones.map((zone) => (
						<SelectItem key={zone} value={zone}>
							{timeZoneLabel(zone)}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p id={helpId} className="text-xs text-muted-foreground">
				{m.settings_timezone_help()}
			</p>
			<SaveStatus state={status.state} data-testid="timezone-save-status" />
		</div>
	);
}
