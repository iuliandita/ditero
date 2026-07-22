import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mutators } from "../../zero/mutators.ts";
import { queries } from "../../zero/queries.ts";
import type { schema } from "../../zero/schema.gen.ts";
import {
	clampFocusConfig,
	DEFAULT_FOCUS,
	type FocusConfig,
} from "../focus/timer-core.ts";
import { runMutation } from "../lib/run-mutation.ts";

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
	setPref: (patch: Partial<UserPrefState>) => void;
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
		};
	}, [rows]);

	const setPref = useCallback(
		(patch: Partial<UserPrefState>) => {
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
			void runMutation(zero.mutate(mutators.userPref.set(arg)), (m) =>
				console.error("userPref.set failed", m),
			);
		},
		[zero],
	);

	const loading = details.type !== "complete";
	const [detected, setDetected] = useState(false);
	const wrote = useRef(false);
	useEffect(() => {
		if (loading || wrote.current) return;
		const zone = detectedTimeZone();
		if (!zone || pref.timezone !== "UTC") return;
		wrote.current = true;
		setDetected(true);
		setPref({ timezone: zone });
	}, [loading, pref.timezone, setPref]);

	return { pref, setPref, loading, timezoneDetected: detected };
}
