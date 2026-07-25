import { type Binding, MODIFIER_KEYS } from "../../domain/keymap.ts";
import { m } from "../../paraglide/messages.js";

const SYMBOL: Record<string, string> = {
	Meta: "⌘",
	Control: "⌃",
	Ctrl: "⌃",
	Shift: "⇧",
	Alt: "⌥",
	Backspace: "⌫",
	Enter: "↵",
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
};

// The two keycaps that are words rather than glyphs. Thunks: this map is
// module-level, and resolving `m` here would freeze the import-time locale.
const WORD_LABELS: Record<string, () => string> = {
	Escape: m.key_esc,
	" ": m.key_space,
};

const keyLabel = (k: string): string =>
	Object.hasOwn(WORD_LABELS, k) ? WORD_LABELS[k]() : (SYMBOL[k] ?? k);

// Chords render tight with the modifier symbol (⌘K); sequences render spaced (g t).
export function formatBinding(b: Binding): string {
	if (MODIFIER_KEYS.has(b[0])) {
		const mods = b.slice(0, -1).map(keyLabel).join("");
		return `${mods}${keyLabel(b[b.length - 1]).toUpperCase()}`;
	}
	return b.map(keyLabel).join(" ");
}
