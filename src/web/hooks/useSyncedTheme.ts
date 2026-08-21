import { useEffect } from "react";
import { applyTheme, fromStored, writeLocalTheme } from "../lib/theme.ts";
import { useUserPref } from "./useUserPref.ts";

// user_pref.theme is the cross-device answer, but its only other reader is the
// effect inside ThemeSwitcher, which mounts on the settings surface alone. On a
// device with empty localStorage the boot hint resolves to "system" and nothing
// ever corrected it until the user opened Settings (#160). Mounted once at the
// shell root, above the restricted/normal split.
//
// A reader, never a writer: it does not call setPref, so it cannot fight the
// switcher or echo a choice back to the server.
export function useSyncedTheme(): void {
	const { pref, loading } = useUserPref();

	useEffect(() => {
		// Before the row arrives pref.theme is the DEFAULTS null, which reads as
		// "system" and would overwrite the boot-time localStorage hint for a user
		// who chose dark -- applying the OS theme and persisting that mistake.
		if (loading) return;
		const synced = fromStored(pref.theme);
		writeLocalTheme(synced);
		applyTheme(synced, document.documentElement);
	}, [loading, pref.theme]);
}
