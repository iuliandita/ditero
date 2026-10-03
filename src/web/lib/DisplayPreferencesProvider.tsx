import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	type Appearance,
	DEFAULT_APPEARANCE,
	migrateLegacyAppearance,
	type ThemeLibrary,
	validateAppearance,
} from "../../domain/appearance.ts";
import type { ThemeDocument } from "../../domain/theme-document.ts";
import {
	type AppearanceSync,
	useAppearanceSync,
} from "../hooks/useAppearanceSync.ts";
import { appearanceSaveSucceeded } from "./appearance-save.ts";
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
	writeThemeLibrary,
} from "./theme-documents.ts";

type DisplayPreferencesContextValue = {
	preferences: DisplayPreferences;
	setPreferences: (patch: Partial<DisplayPreferences>) => void;
	saveFailed: boolean;
	themeLibrary: ThemeLibrary;
	setThemeLibrary: (next: ThemeLibrary) => Promise<boolean>;
	setThemePreview: (document: ThemeDocument | null) => void;
	themePreviewActive: boolean;
	appearanceLoading: boolean;
	appearancePending: boolean;
	appearanceAccepted: boolean;
	appearanceSaveFailed: boolean;
	appearanceCacheFailed: boolean;
	retryAppearance: () => void;
};
const DisplayPreferencesContext =
	createContext<DisplayPreferencesContextValue | null>(null);

export function SyncedDisplayPreferencesProvider({
	userId,
	children,
}: {
	userId: string;
	children: ReactNode;
}) {
	const sync = useAppearanceSync();
	return (
		<DisplayPreferencesProvider userId={userId} sync={sync}>
			{children}
		</DisplayPreferencesProvider>
	);
}

// The authenticated provider lives inside the account-owned Zero client. The
// standalone auth routes have no Zero transport and use local hints only.
export function DisplayPreferencesProvider({
	userId,
	sync,
	children,
}: {
	userId: string | null;
	sync?: AppearanceSync;
	children: ReactNode;
}) {
	const [devicePreferences, setDevicePreferences] = useState(() =>
		readDisplayPreferences(userId),
	);
	const currentDevicePreferences = useRef(devicePreferences);
	currentDevicePreferences.current = devicePreferences;
	const [localAppearance, setLocalAppearance] = useState<Appearance>(() => ({
		...readThemeLibrary(userId),
		accentTheme: devicePreferences.accentTheme,
	}));
	const legacy = useRef(localAppearance);
	const [saveFailed, setSaveFailed] = useState(false);
	const [themePreview, setThemePreview] = useState<ThemeDocument | null>(null);
	const [pending, setPending] = useState(0);
	const [accepted, setAccepted] = useState(false);
	const [appearanceSaveFailed, setAppearanceSaveFailed] = useState(false);
	const [appearanceCacheFailed, setAppearanceCacheFailed] = useState(false);
	const retry = useRef<Appearance | null>(null);
	const active = useRef(true);
	const attempt = useRef(0);
	const appearance =
		sync && !sync.loading
			? (sync.appearance ?? DEFAULT_APPEARANCE)
			: localAppearance;
	const { accentTheme, ...themeLibrary } = appearance;
	const preferences = useMemo(
		() => ({ ...devicePreferences, accentTheme }),
		[devicePreferences, accentTheme],
	);

	useLayoutEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	useLayoutEffect(() => {
		applyDisplayPreferences(preferences, document.documentElement);
	}, [preferences]);
	useLayoutEffect(() => {
		const selected = selectedThemeDocument(appearance);
		applyThemeDocument(
			themePreview ??
				(selected
					? resolveThemeDocument(
							selected,
							appearance.accentTheme,
							appearance.useAccent,
						)
					: null),
			document.documentElement,
		);
	}, [appearance, themePreview]);
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

	async function saveAppearance(input: Appearance): Promise<boolean> {
		if (
			!userId ||
			!active.current ||
			sync?.loading ||
			(sync && !sync.isActive())
		)
			return false;
		const epoch = ++attempt.current;
		let next: Appearance;
		try {
			next = validateAppearance(input);
		} catch {
			setAppearanceSaveFailed(true);
			return false;
		}
		setAppearanceSaveFailed(false);
		retry.current = next;
		const library: ThemeLibrary = {
			selected: next.selected,
			useAccent: next.useAccent,
			documents: next.documents,
		};
		if (!sync) {
			const saved = writeThemeLibrary(userId, library);
			if (saved) {
				setLocalAppearance(next);
				writeDisplayPreferences(userId, {
					...currentDevicePreferences.current,
					accentTheme: next.accentTheme,
				});
			}
			setAppearanceSaveFailed(!saved);
			return saved;
		}
		setPending((count) => count + 1);
		setAccepted(false);
		let saved = false;
		try {
			saved = await appearanceSaveSucceeded(sync.mutate(next), () => {
				if (active.current && epoch === attempt.current) setAccepted(true);
			});
		} catch {
			saved = false;
		}
		if (!active.current) return saved;
		setPending((count) => count - 1);
		if (epoch !== attempt.current) return saved;
		setAppearanceSaveFailed(!saved);
		if (saved) {
			retry.current = null;
			// This is a boot hint, never an acknowledgment or the source of truth.
			const cached = writeThemeLibrary(userId, library);
			const displayCached = writeDisplayPreferences(userId, {
				...currentDevicePreferences.current,
				accentTheme: next.accentTheme,
			});
			setAppearanceCacheFailed(!cached || !displayCached);
		}
		return saved;
	}
	function nextAppearance(
		next: ThemeLibrary,
		nextAccent?: Appearance["accentTheme"],
	): Appearance {
		const unset = sync && !sync.loading && sync.appearance === null;
		const candidate = {
			...next,
			accentTheme:
				nextAccent ??
				(unset ? legacy.current.accentTheme : appearance.accentTheme),
		};
		return unset
			? migrateLegacyAppearance(legacy.current, candidate)
			: validateAppearance(candidate);
	}
	async function setThemeLibrary(next: ThemeLibrary): Promise<boolean> {
		try {
			return await saveAppearance(nextAppearance(next));
		} catch {
			setAppearanceSaveFailed(true);
			return false;
		}
	}
	function setPreferences(patch: Partial<DisplayPreferences>) {
		if (!userId) return;
		if (patch.readingSize !== undefined || patch.highContrast !== undefined) {
			const next = {
				...devicePreferences,
				...patch,
				accentTheme: preferences.accentTheme,
			};
			setDevicePreferences(next);
			setSaveFailed(!writeDisplayPreferences(userId, next));
		}
		if (patch.accentTheme) {
			try {
				void saveAppearance(
					nextAppearance(
						{ ...themeLibrary, useAccent: true },
						patch.accentTheme,
					),
				);
			} catch {
				setAppearanceSaveFailed(true);
			}
		}
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
				appearanceLoading: sync?.loading ?? false,
				appearancePending: pending > 0,
				appearanceAccepted: accepted,
				appearanceSaveFailed,
				appearanceCacheFailed,
				retryAppearance: () => {
					if (retry.current && pending === 0)
						void saveAppearance(retry.current);
				},
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
