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

const TEXT: Record<string, string> = {
	Meta: "Ctrl",
	Control: "Ctrl",
	Ctrl: "Ctrl",
	Shift: "Shift",
	Alt: "Alt",
	Backspace: "Backspace",
	Enter: "Enter",
};

// Meta and Control both match the portable accelerator in the keymap runtime.
export function formatBinding(
	b: Binding,
	platform = globalThis.navigator?.platform ?? "",
): string {
	const apple = /Mac|iPhone|iPad|iPod/i.test(platform);
	const keyLabel = (key: string): string =>
		Object.hasOwn(WORD_LABELS, key)
			? WORD_LABELS[key]()
			: (!apple && TEXT[key]) || SYMBOL[key] || key;
	if (MODIFIER_KEYS.has(b[0])) {
		const key = keyLabel(b[b.length - 1]);
		const keys = [
			...b.slice(0, -1).map(keyLabel),
			apple || key.length === 1 ? key.toUpperCase() : key,
		];
		return keys.join(apple ? "" : "+");
	}
	return b.map(keyLabel).join(" ");
}
