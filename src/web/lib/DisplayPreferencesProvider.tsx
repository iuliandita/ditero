import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useState,
} from "react";
import type { ThemeDocument } from "../../domain/theme-document.ts";
import {
	applyDisplayPreferences,
	DEFAULT_DISPLAY_PREFERENCES,
	type DisplayPreferences,
	readDisplayPreferences,
	writeDisplayPreferences,
} from "./display-preferences.ts";
import {
	applyThemeDocument,
	readThemeLibrary,
	resolveThemeDocument,
	selectedThemeDocument,
	type ThemeLibrary,
	writeThemeLibrary,
} from "./theme-documents.ts";

type DisplayPreferencesContextValue = {
	preferences: DisplayPreferences;
	setPreferences: (patch: Partial<DisplayPreferences>) => void;
	saveFailed: boolean;
	themeLibrary: ThemeLibrary;
	setThemeLibrary: (next: ThemeLibrary) => boolean;
	setThemePreview: (document: ThemeDocument | null) => void;
	themePreviewActive: boolean;
};

const DisplayPreferencesContext =
	createContext<DisplayPreferencesContextValue | null>(null);

// Routes keys this provider by the authenticated account. No previous-account
// hint is read at boot, and the logged-out page always has safe defaults.
export function DisplayPreferencesProvider({
	userId,
	children,
}: {
	userId: string | null;
	children: ReactNode;
}) {
	const [preferences, setValue] = useState(() =>
		readDisplayPreferences(userId),
	);
	const [saveFailed, setSaveFailed] = useState(false);
	const [themeLibrary, setLibrary] = useState(() => readThemeLibrary(userId));
	const [themePreview, setThemePreview] = useState<ThemeDocument | null>(null);

	useLayoutEffect(() => {
		applyDisplayPreferences(preferences, document.documentElement);
	}, [preferences]);
	useLayoutEffect(() => {
		const selected = selectedThemeDocument(themeLibrary);
		applyThemeDocument(
			themePreview ??
				(selected
					? resolveThemeDocument(
							selected,
							preferences.accentTheme,
							themeLibrary.useAccent,
						)
					: null),
			document.documentElement,
		);
	}, [themeLibrary, preferences.accentTheme, themePreview]);

	useLayoutEffect(
		() => () => {
			applyThemeDocument(null, document.documentElement);
			applyDisplayPreferences(
				DEFAULT_DISPLAY_PREFERENCES,
				document.documentElement,
			);
		},
		[],
	);

	function setPreferences(patch: Partial<DisplayPreferences>) {
		if (!userId) return;
		const next = { ...preferences, ...patch };
		setValue(next);
		const displaySaved = writeDisplayPreferences(userId, next);
		let themeSaved = true;
		if (patch.accentTheme) {
			const library = { ...themeLibrary, useAccent: true };
			setLibrary(library);
			themeSaved = writeThemeLibrary(userId, library);
		}
		setSaveFailed(!displaySaved || !themeSaved);
	}
	function setThemeLibrary(next: ThemeLibrary) {
		if (!userId) return false;
		const saved = writeThemeLibrary(userId, next);
		if (saved) setLibrary(next);
		setSaveFailed(!saved);
		return saved;
	}

	return (
		<DisplayPreferencesContext
			value={{
				preferences,
				setPreferences,
				saveFailed,
				themeLibrary,
				setThemeLibrary,
				setThemePreview,
				themePreviewActive: themePreview !== null,
			}}
		>
			{children}
		</DisplayPreferencesContext>
	);
}

export function useDisplayPreferences(): DisplayPreferencesContextValue {
	const context = useContext(DisplayPreferencesContext);
	if (!context) throw new Error("missing DisplayPreferencesProvider");
	return context;
}
