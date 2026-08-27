import {
	applyTheme,
	fromStored,
	isTheme,
	readLocalTheme,
	type Theme,
	toStored,
	writeLocalTheme,
} from "../lib/theme.ts";
import { useUserPref } from "./useUserPref.ts";

// The shared read/write half of the theme controls. Applying is still
// useSyncedTheme's job (#160), so this reaches devices whose user never touches
// a control; the local write here only makes the document change on the click
// instead of one round trip later. Extracted so the Settings select and the
// sidebar menu cannot drift on which of the three states is current.
export function useThemeChoice(): {
	theme: Theme;
	setTheme: (next: string) => void;
} {
	const { pref, setPref, loading } = useUserPref();
	// Until the row lands pref.theme is the DEFAULTS null, which would display
	// "system" to a user whose document is already dark from the boot hint.
	const theme = loading ? readLocalTheme() : fromStored(pref.theme);

	function setTheme(next: string) {
		if (!isTheme(next)) return;
		writeLocalTheme(next);
		applyTheme(next, document.documentElement);
		setPref({ theme: toStored(next) });
	}

	return { theme, setTheme };
}
