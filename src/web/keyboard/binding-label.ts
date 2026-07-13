import { type Binding, MODIFIER_KEYS } from "../../domain/keymap.ts";

const SYMBOL: Record<string, string> = {
	Meta: "⌘",
	Control: "⌃",
	Ctrl: "⌃",
	Shift: "⇧",
	Alt: "⌥",
	Backspace: "⌫",
	Enter: "↵",
	Escape: "Esc",
	ArrowUp: "↑",
	ArrowDown: "↓",
	ArrowLeft: "←",
	ArrowRight: "→",
	" ": "Space",
};

const keyLabel = (k: string): string => SYMBOL[k] ?? k;

// Chords render tight with the modifier symbol (⌘K); sequences render spaced (g t).
export function formatBinding(b: Binding): string {
	if (MODIFIER_KEYS.has(b[0])) {
		const mods = b.slice(0, -1).map(keyLabel).join("");
		return `${mods}${keyLabel(b[b.length - 1]).toUpperCase()}`;
	}
	return b.map(keyLabel).join(" ");
}
