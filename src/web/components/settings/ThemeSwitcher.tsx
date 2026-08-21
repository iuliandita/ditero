import { useId } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { m } from "../../../paraglide/messages.js";
import { useUserPref } from "../../hooks/useUserPref.ts";
import {
	applyTheme,
	fromStored,
	isTheme,
	readLocalTheme,
	toStored,
	writeLocalTheme,
} from "../../lib/theme.ts";

// A control, not an applier: useSyncedTheme() owns applying the synced choice
// so it also reaches devices whose user never opens this surface (#160). The
// write below is still done here, so the document changes on the click rather
// than one round trip later.
export function ThemeSwitcher() {
	const { pref, setPref, loading } = useUserPref();
	const labelId = useId();
	// Until the row lands pref.theme is the DEFAULTS null, which would display
	// "system" to a user whose document is already dark from the boot hint.
	const value = loading ? readLocalTheme() : fromStored(pref.theme);

	function onChange(next: string) {
		if (!isTheme(next)) return;
		writeLocalTheme(next);
		applyTheme(next, document.documentElement);
		setPref({ theme: toStored(next) });
	}

	return (
		<div className="flex flex-col gap-1 text-sm">
			<span id={labelId} className="text-muted-foreground">
				{m.theme_switcher_label()}
			</span>
			<Select value={value} onValueChange={onChange}>
				<SelectTrigger
					aria-labelledby={labelId}
					data-testid="theme-switcher"
					className="w-full sm:w-56"
				>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="system">{m.theme_system()}</SelectItem>
					<SelectItem value="light">{m.theme_light()}</SelectItem>
					<SelectItem value="dark">{m.theme_dark()}</SelectItem>
				</SelectContent>
			</Select>
		</div>
	);
}
