import { useEffect, useId, useState } from "react";
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
	type Theme,
	toStored,
	writeLocalTheme,
} from "../../lib/theme.ts";

export function ThemeSwitcher() {
	const { pref, setPref } = useUserPref();
	const [value, setValue] = useState<Theme>(readLocalTheme());
	const labelId = useId();

	// The synced preference wins once it arrives: it is the cross-device answer,
	// while localStorage is only the boot-time hint that avoids the flash.
	useEffect(() => {
		const synced = fromStored(pref.theme);
		setValue(synced);
		writeLocalTheme(synced);
		applyTheme(synced, document.documentElement);
	}, [pref.theme]);

	function onChange(next: string) {
		if (!isTheme(next)) return;
		setValue(next);
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
