import { type Binding, MODIFIER_KEYS } from "../../domain/keymap.ts";

// Pure keydown -> Binding reducer for the rebind UI, DOM-free so it unit-tests
// without a browser. M1c scope: single-key + one Meta/Ctrl chord only. Two-key
// SEQUENCES (g t, d d) are NOT user-capturable here -- they ship as profile
// defaults and are only removable via per-command reset. The `keys` buffer is
// kept for the signature/future sequence support; today captures complete in one
// step so it never carries state across calls.
export type CaptureState = { keys: string[] };

export const EMPTY_CAPTURE: CaptureState = { keys: [] };

export function stepCapture(
	state: CaptureState,
	ev: { key: string; metaKey: boolean; ctrlKey: boolean },
): { state: CaptureState; binding: Binding | null } {
	// A held Meta/Ctrl + a real key completes immediately, normalized to
	// ["Meta", key] -- the runtime handler treats Meta/Ctrl equivalently and
	// commands.ts stores the palette chord as ["Meta","k"].
	if (ev.metaKey || ev.ctrlKey) {
		if (MODIFIER_KEYS.has(ev.key)) return { state, binding: null };
		return { state: EMPTY_CAPTURE, binding: ["Meta", ev.key] };
	}
	// A bare modifier keydown never completes -- wait for the real key.
	if (MODIFIER_KEYS.has(ev.key)) return { state, binding: null };
	// Any other single key is the finished binding.
	return { state: EMPTY_CAPTURE, binding: [ev.key] };
}
