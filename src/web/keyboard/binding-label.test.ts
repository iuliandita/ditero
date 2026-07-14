import { describe, expect, test } from "vitest";
import { formatBinding } from "./binding-label.ts";

describe("formatBinding", () => {
	test("renders a Meta chord tight with the symbol", () => {
		expect(formatBinding(["Meta", "k"])).toBe("⌘K");
	});

	test("renders a two-key sequence spaced", () => {
		expect(formatBinding(["g", "t"])).toBe("g t");
	});

	test("renders a single key as-is", () => {
		expect(formatBinding(["j"])).toBe("j");
	});

	test("maps named keys to symbols", () => {
		expect(formatBinding(["Enter"])).toBe("↵");
		expect(formatBinding(["Backspace"])).toBe("⌫");
	});
});
