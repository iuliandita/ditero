import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useState,
} from "react";
import {
	applyDisplayPreferences,
	DEFAULT_DISPLAY_PREFERENCES,
	type DisplayPreferences,
	readDisplayPreferences,
	writeDisplayPreferences,
} from "./display-preferences.ts";

type DisplayPreferencesContextValue = {
	preferences: DisplayPreferences;
	setPreferences: (patch: Partial<DisplayPreferences>) => void;
	saveFailed: boolean;
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

	useLayoutEffect(() => {
		applyDisplayPreferences(preferences, document.documentElement);
	}, [preferences]);

	useLayoutEffect(
		() => () => {
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
		setSaveFailed(!writeDisplayPreferences(userId, next));
	}

	return (
		<DisplayPreferencesContext
			value={{ preferences, setPreferences, saveFailed }}
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
