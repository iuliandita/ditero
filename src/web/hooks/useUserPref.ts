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

export type UserPrefState = {
	keymap: Record<string, string[][]>; // command id -> Binding[]
	keymapProfile: "default" | "vim";
	homeViewRef: string | null; // built-in id or view.id; null => DEFAULT_HOME
	pinnedViews: string[];
	focus: FocusConfig; // pomodoro config; clamped to the mutator caps on read
};

const DEFAULTS: UserPrefState = {
	keymap: {},
	keymapProfile: "default",
	homeViewRef: null,
	pinnedViews: [],
	focus: { ...DEFAULT_FOCUS },
};

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
		};
	}, [rows]);

	function setPref(patch: Partial<UserPrefState>) {
		// focus is a typed object here but ReadonlyJSONValue at the mutator boundary.
		const { focus, ...rest } = patch;
		const arg = {
			...rest,
			...(focus !== undefined
				? { focus: focus as unknown as ReadonlyJSONValue }
				: {}),
		};
		void runMutation(zero.mutate(mutators.userPref.set(arg)), (m) =>
			console.error("userPref.set failed", m),
		);
	}

	return { pref, setPref, loading: details.type !== "complete" };
}
