import { describe, expect, it } from "vitest";
import { applyTheme, fromStored, isTheme, toStored } from "./theme.ts";

// No DOM environment in this suite (see vitest.config.ts) -- a plain
// classList-shaped stub exercises the remove-then-add contract without
// needing document.createElement.
function fakeRoot(): HTMLElement {
	const classes = new Set<string>();
	return {
		classList: {
			remove: (...names: string[]) => {
				for (const n of names) classes.delete(n);
			},
			add: (...names: string[]) => {
				for (const n of names) classes.add(n);
			},
			[Symbol.iterator]: () => classes[Symbol.iterator](),
		},
	} as unknown as HTMLElement;
}

describe("applyTheme", () => {
	it("dark leaves exactly dark", () => {
		const el = fakeRoot();
		applyTheme("dark", el);
		expect([...el.classList]).toEqual(["dark"]);
	});

	it("light after dark leaves exactly light", () => {
		const el = fakeRoot();
		applyTheme("dark", el);
		applyTheme("light", el);
		expect([...el.classList]).toEqual(["light"]);
	});

	it("system after either leaves the list empty", () => {
		const el = fakeRoot();
		applyTheme("dark", el);
		applyTheme("system", el);
		expect([...el.classList]).toEqual([]);

		const el2 = fakeRoot();
		applyTheme("light", el2);
		applyTheme("system", el2);
		expect([...el2.classList]).toEqual([]);
	});
});

describe("toStored / fromStored", () => {
	it("toStored(system) is null", () => {
		expect(toStored("system")).toBeNull();
	});

	it("fromStored(null) is system", () => {
		expect(fromStored(null)).toBe("system");
	});

	it("fromStored(dark) is dark", () => {
		expect(fromStored("dark")).toBe("dark");
	});

	it("fromStored(undefined) is system", () => {
		expect(fromStored(undefined)).toBe("system");
	});
});

describe("isTheme", () => {
	it("rejects Dark, empty string, null, and an arbitrary string", () => {
		expect(isTheme("Dark")).toBe(false);
		expect(isTheme("")).toBe(false);
		expect(isTheme(null)).toBe(false);
		expect(isTheme("sepia")).toBe(false);
	});

	it("accepts the three real values", () => {
		expect(isTheme("system")).toBe(true);
		expect(isTheme("light")).toBe(true);
		expect(isTheme("dark")).toBe(true);
	});
});
