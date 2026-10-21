import { expect, test } from "vitest";
import { formatBinding } from "./binding-label.ts";

test.each([
	["MacIntel", "⌘⇧K", "↵", "⌫"],
	["Linux x86_64", "Ctrl+Shift+K", "Enter", "Backspace"],
	["Win32", "Ctrl+Shift+K", "Enter", "Backspace"],
] as const)("labels shortcuts for %s", (platform, chord, enter, backspace) => {
	expect(formatBinding(["Meta", "Shift", "k"], platform)).toBe(chord);
	expect(formatBinding(["Enter"], platform)).toBe(enter);
	expect(formatBinding(["Backspace"], platform)).toBe(backspace);
	expect(formatBinding(["g", "t"], platform)).toBe("g t");
	expect(formatBinding(["j"], platform)).toBe("j");
});
