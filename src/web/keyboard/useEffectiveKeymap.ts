import { useMemo } from "react";
import { type EffectiveKeymap, resolveKeymap } from "../../domain/keymap.ts";
import { useUserPref } from "../hooks/useUserPref.ts";
import { COMMANDS } from "./commands.ts";

// Effective keymap = defaults (+) vim-profile (+) user overrides, resolved by the
// pure resolveKeymap so a rebind (Task 10) reflects in the handler + cheat-sheet.
export function useEffectiveKeymap(): EffectiveKeymap {
	const { pref } = useUserPref();
	return useMemo(
		() => resolveKeymap(COMMANDS, pref.keymapProfile, pref.keymap),
		[pref.keymapProfile, pref.keymap],
	);
}
