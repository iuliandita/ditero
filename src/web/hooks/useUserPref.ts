import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type AutoLockMinutes,
	isAutoLockMinutes,
} from "../../domain/e2e/auto-lock.ts";
import { m } from "../../paraglide/messages.js";
import { getLocale, setLocale } from "../../paraglide/runtime.js";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import { useSnackbar } from "../components/ui/snackbar.tsx";
import {
	clampFocusConfig,
	DEFAULT_FOCUS,
	type FocusConfig,
} from "../focus/timer-core.ts";
import {
	applyDocumentLocale,
	isSupportedLocale,
	type Locale,
} from "../lib/locale.ts";
import { reconcileStoredLocale } from "../lib/locale-reconciliation.ts";
import { mutationServerSucceeded } from "../lib/pref-mutation.ts";
import { timeZoneToDetect } from "../lib/timezone-detection.ts";
import {
	isZeroClientOwnerActive,
	retireZeroClients,
} from "../lib/zero-lifecycle.ts";

export type KarmaGoals = { daily: number; weekly: number };
export type Vacation = { active: boolean; until?: string };
export type QuietHours = { start: string; end: string } | null;
export type EscalationDefaults = {
	repeatEveryMin: number | null;
	maxRepeats: number | null;
	fallbackUserId: string | null;
};

export type UserPrefState = {
	keymap: Record<string, string[][]>; // command id -> Binding[]
	keymapProfile: "default" | "vim";
	homeViewRef: string | null; // built-in id or view.id; null => DEFAULT_HOME
	pinnedViews: string[];
	focus: FocusConfig; // pomodoro config; clamped to the mutator caps on read
	karmaGoals: KarmaGoals; // daily/weekly completion targets (0 => unset)
	vacation: Vacation; // pauses streak breaks + goal penalties while active
	timezone: string; // IANA zone every reminder time is interpreted in
	timezoneChosen: boolean; // picked in settings; detection leaves it alone
	quietHours: QuietHours; // null => not configured
	escalationDefaults: EscalationDefaults | null; // null => not configured
	locale: Locale | null; // null => no preference set (Accept-Language fallback)
	theme: "light" | "dark" | null; // null => follow the OS
	// null => unset; domain/e2e/auto-lock.ts resolves it. 0 is the real choice
	// "never", not an absence, so it must not be collapsed into null here.
	e2eAutoLockMinutes: AutoLockMinutes | null;
};

const DEFAULTS: UserPrefState = {
	keymap: {},
	keymapProfile: "default",
	homeViewRef: null,
	pinnedViews: [],
	focus: { ...DEFAULT_FOCUS },
	karmaGoals: { daily: 0, weekly: 0 },
	vacation: { active: false },
	timezone: "UTC",
	timezoneChosen: false,
	quietHours: null,
	escalationDefaults: null,
	locale: null,
	theme: null,
	e2eAutoLockMinutes: null,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function readQuietHours(v: unknown): QuietHours {
	const o = (v ?? {}) as Partial<Record<"start" | "end", unknown>>;
	if (typeof o.start !== "string" || typeof o.end !== "string") return null;
	if (!HHMM.test(o.start) || !HHMM.test(o.end)) return null;
	return { start: o.start, end: o.end };
}

function readEscalationDefaults(v: unknown): EscalationDefaults | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Partial<Record<keyof EscalationDefaults, unknown>>;
	const num = (x: unknown) => (typeof x === "number" ? x : null);
	return {
		repeatEveryMin: num(o.repeatEveryMin),
		maxRepeats: num(o.maxRepeats),
		fallbackUserId:
			typeof o.fallbackUserId === "string" ? o.fallbackUserId : null,
	};
}

// The browser is the only place that knows the user's zone, and a wrong zone
// silently mistimes every reminder (design 0). A stored "UTC" is the column
// default unless the user picked it in settings (timezoneChosen); detection
// replaces only the unchosen default, and only with a real zone.
//
// Key detection to the account so a same-tab sign-in cannot inherit the
// previous account's attempt. Locale reconciliation belongs to each client.
let detectionAttemptedForUserId: string | undefined;
let detectionWrote = false;

function detectedTimeZone(): string | null {
	try {
		const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return zone && zone !== "UTC" ? zone : null;
	} catch {
		return null;
	}
}

// Clamp goal fields to the mutator caps (0..1000) so a stored/edited value can
// never drive an out-of-range write; mirrors clampFocusConfig's posture.
function clampGoals(v: unknown): KarmaGoals {
	const o = (v ?? {}) as Partial<Record<keyof KarmaGoals, unknown>>;
	const num = (x: unknown): number => {
		const n = Math.trunc(Number(x));
		if (!Number.isFinite(n) || n < 0) return 0;
		return n > 1000 ? 1000 : n;
	};
	return { daily: num(o.daily), weekly: num(o.weekly) };
}

function readVacation(v: unknown): Vacation {
	const o = (v ?? {}) as Partial<Record<keyof Vacation, unknown>>;
	return {
		active: o.active === true,
		...(typeof o.until === "string" && o.until ? { until: o.until } : {}),
	};
}

// The caller's single user_pref row, or DEFAULTS on first-run (no row yet).
// Raw pref state only -- effectiveKeymap is resolved downstream where the
// command registry is available (Task 9). Writes upsert via userPref.set.
export function useUserPref(): {
	pref: UserPrefState;
	setPref: (patch: Partial<UserPrefState>) => Promise<boolean>;
	loading: boolean;
	// True when this session's detection supplied the zone, so the settings
	// surface can ask "is this right?" instead of stating it as settled.
	timezoneDetected: boolean;
} {
	const zero = useZero<typeof schema>();
	const { show } = useSnackbar();
	const [rows, details] = useQuery(queries.userPrefs.mine());

	const pref = useMemo<UserPrefState>(() => {
		const row = rows[0];
		if (!row) return DEFAULTS;
		return {
			keymap: (row.keymap as Record<string, string[][]>) ?? DEFAULTS.keymap,
			keymapProfile: row.keymapProfile ?? DEFAULTS.keymapProfile,
			homeViewRef: row.homeViewRef ?? DEFAULTS.homeViewRef,
			pinnedViews: (row.pinnedViews as string[]) ?? DEFAULTS.pinnedViews,
			focus: clampFocusConfig(row.focus),
			karmaGoals: clampGoals(row.karmaGoals),
			vacation: readVacation(row.vacation),
			timezone: row.timezone ?? DEFAULTS.timezone,
			timezoneChosen: row.timezoneChosen === true,
			quietHours: readQuietHours(row.quietHours),
			escalationDefaults: readEscalationDefaults(row.escalationDefaults),
			locale:
				typeof row.locale === "string" && isSupportedLocale(row.locale)
					? row.locale
					: null,
			theme: row.theme === "light" || row.theme === "dark" ? row.theme : null,
			// Anything not on the offered list reads as unset: a stored 7 has no
			// label in the Select and would render an empty control the user
			// cannot correct.
			e2eAutoLockMinutes: isAutoLockMinutes(row.e2eAutoLockMinutes)
				? row.e2eAutoLockMinutes
				: null,
		};
	}, [rows]);

	const setPref = useCallback(
		async (patch: Partial<UserPrefState>) => {
			// Typed objects here, ReadonlyJSONValue at the mutator boundary; goals are
			// re-clamped so a write can never exceed the server caps.
			const {
				focus,
				karmaGoals,
				vacation,
				quietHours,
				escalationDefaults,
				...rest
			} = patch;
			const arg = {
				...rest,
				...(focus !== undefined
					? { focus: focus as unknown as ReadonlyJSONValue }
					: {}),
				...(karmaGoals !== undefined
					? {
							karmaGoals: clampGoals(
								karmaGoals,
							) as unknown as ReadonlyJSONValue,
						}
					: {}),
				...(vacation !== undefined
					? { vacation: vacation as unknown as ReadonlyJSONValue }
					: {}),
				...(quietHours !== undefined
					? { quietHours: quietHours as unknown as ReadonlyJSONValue }
					: {}),
				...(escalationDefaults !== undefined
					? {
							escalationDefaults:
								escalationDefaults as unknown as ReadonlyJSONValue,
						}
					: {}),
			};
			const succeeded = await mutationServerSucceeded(
				zero.mutate(mutators.userPref.set(arg)),
			);
			if (!succeeded) console.error("userPref.set failed");
			return succeeded;
		},
		[zero],
	);

	const loading = details.type !== "complete";
	// Module-scoped, not a per-instance ref: ReminderChip calls this hook and
	// renders once per task row, so N mounted instances would otherwise all see
	// the stored "UTC" in the same flush and fire N identical writes for one
	// fact. The first instance to get there writes; the rest read the flag.
	const [, forceRender] = useState(0);
	useEffect(() => {
		if (loading || detectionAttemptedForUserId === zero.userID) return;
		// Reconciliation retires this client; detect after the locale reload.
		if (pref.locale !== null && pref.locale !== getLocale()) return;
		const zone = timeZoneToDetect(pref, detectedTimeZone());
		detectionAttemptedForUserId = zero.userID;
		if (!zone) return;
		detectionWrote = true;
		forceRender((n) => n + 1);
		void setPref({ timezone: zone });
	}, [loading, pref, setPref, zero.userID]);

	useEffect(() => {
		if (loading) return;
		void reconcileStoredLocale(zero, pref.locale, {
			currentLocale: getLocale,
			isOwnerActive: () => isZeroClientOwnerActive(zero),
			retireClients: (retryFailed) => retireZeroClients({ retryFailed }),
			applyLocale: (locale) => {
				applyDocumentLocale(locale);
				setLocale(locale);
			},
			onError: (retry) =>
				show({
					message: m.sync_save_pending_failed(),
					action: { label: m.action_retry(), run: retry },
				}),
		});
	}, [loading, pref.locale, zero, show]);

	return { pref, setPref, loading, timezoneDetected: detectionWrote };
}
