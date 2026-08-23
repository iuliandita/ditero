import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	type AutoLockMinutes,
	isAutoLockMinutes,
} from "../../domain/e2e/auto-lock.ts";
import { getLocale, setLocale } from "../../paraglide/runtime.js";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
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
import { mutationServerSucceeded } from "../lib/pref-mutation.ts";

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
// silently mistimes every reminder (design 0). There is no timezone edit
// control in M3a, so a stored "UTC" is always the column default rather than a
// deliberate choice -- detection may overwrite it, but only with a real zone.
//
// Both guards below are keyed to the signed-in user id, not a plain boolean:
// passkey/2FA verification, signup, and sign-out do not reload the page, so a
// same-tab account switch (user A signs out, user B signs in) would otherwise
// leave a bare "already attempted" flag set from A's session and silently
// suppress B's detection/reconcile. Keying to userId resets the guard exactly
// when the signed-in user changes, while still firing at most once per user
// per tab session (a reload after reconcile makes getLocale() match, so the
// effect below no-ops on the next run for the same user -- no reload loop).
let detectionAttemptedForUserId: string | undefined;
let detectionWrote = false;

let localeReconcileAttemptedForUserId: string | undefined;

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
		const zone = detectedTimeZone();
		if (!zone || pref.timezone !== "UTC") {
			detectionAttemptedForUserId = zero.userID;
			return;
		}
		detectionAttemptedForUserId = zero.userID;
		detectionWrote = true;
		forceRender((n) => n + 1);
		void setPref({ timezone: zone });
	}, [loading, pref.timezone, setPref, zero.userID]);

	useEffect(() => {
		if (loading || localeReconcileAttemptedForUserId === zero.userID) return;
		localeReconcileAttemptedForUserId = zero.userID;
		if (pref.locale && pref.locale !== getLocale()) {
			applyDocumentLocale(pref.locale);
			setLocale(pref.locale);
		}
	}, [loading, pref.locale, zero.userID]);

	return { pref, setPref, loading, timezoneDetected: detectionWrote };
}
