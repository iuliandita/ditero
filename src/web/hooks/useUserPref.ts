import type { ReadonlyJSONValue } from "@rocicorp/zero";
import { useQuery, useZero } from "@rocicorp/zero/react";
import { useMemo } from "react";
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

export type UserPrefState = {
	keymap: Record<string, string[][]>; // command id -> Binding[]
	keymapProfile: "default" | "vim";
	homeViewRef: string | null; // built-in id or view.id; null => DEFAULT_HOME
	pinnedViews: string[];
	focus: FocusConfig; // pomodoro config; clamped to the mutator caps on read
	karmaGoals: KarmaGoals; // daily/weekly completion targets (0 => unset)
	vacation: Vacation; // pauses streak breaks + goal penalties while active
};

const DEFAULTS: UserPrefState = {
	keymap: {},
	keymapProfile: "default",
	homeViewRef: null,
	pinnedViews: [],
	focus: { ...DEFAULT_FOCUS },
	karmaGoals: { daily: 0, weekly: 0 },
	vacation: { active: false },
};

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
		};
	}, [rows]);

	function setPref(patch: Partial<UserPrefState>) {
		// Typed objects here, ReadonlyJSONValue at the mutator boundary; goals are
		// re-clamped so a write can never exceed the server caps.
		const { focus, karmaGoals, vacation, ...rest } = patch;
		const arg = {
			...rest,
			...(focus !== undefined
				? { focus: focus as unknown as ReadonlyJSONValue }
				: {}),
			...(karmaGoals !== undefined
				? { karmaGoals: clampGoals(karmaGoals) as unknown as ReadonlyJSONValue }
				: {}),
			...(vacation !== undefined
				? { vacation: vacation as unknown as ReadonlyJSONValue }
				: {}),
		};
		void runMutation(zero.mutate(mutators.userPref.set(arg)), (m) =>
			console.error("userPref.set failed", m),
		);
	}

	return { pref, setPref, loading: details.type !== "complete" };
}
