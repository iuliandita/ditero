import { describe, expect, test } from "vitest";
import {
	navSectionOpen,
	navSectionsKey,
	parseNavSections,
	readNavSections,
	toggleNavSection,
	writeNavSections,
} from "./nav-sections.ts";

function memory(): Storage {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => void map.set(k, v),
		removeItem: (k) => void map.delete(k),
		clear: () => map.clear(),
		key: () => null,
		get length() {
			return map.size;
		},
	};
}

describe("nav section collapse state", () => {
	test("round-trips per user without leaking across users", () => {
		const store = memory();
		writeNavSections("u1", { views: false }, store);
		expect(readNavSections("u1", store)).toEqual({ views: false });
		expect(readNavSections("u2", store)).toEqual({});
		expect(store.getItem(navSectionsKey("u1"))).toBe('{"views":false}');
	});

	test("garbage and unknown sections preserve content defaults", () => {
		expect(parseNavSections("not json")).toEqual({});
		expect(
			parseNavSections('{"views":"open","lists":true,"__proto__":true}'),
		).toEqual({});
	});

	test("empty groups fold away while saved items stay discoverable", () => {
		expect(navSectionOpen({}, "views", false)).toBe(false);
		expect(navSectionOpen({}, "dashboards", true)).toBe(true);
	});

	test("explicit empty expansion survives storage and new items", () => {
		const store = memory();
		const preferences = toggleNavSection({}, "views", false);
		writeNavSections("u1", preferences, store);
		expect(navSectionOpen(readNavSections("u1", store), "views", false)).toBe(
			true,
		);
		expect(navSectionOpen(preferences, "views", true)).toBe(true);
		expect(navSectionOpen(preferences, "dashboards", false)).toBe(false);
		expect(
			navSectionOpen(
				toggleNavSection(preferences, "views", false),
				"views",
				true,
			),
		).toBe(false);
	});

	test("legacy arrays preserve both collapse and explicit expansion", () => {
		expect(parseNavSections('["dashboards","lists","__proto__"]')).toEqual({
			views: true,
			dashboards: false,
		});
		expect(parseNavSections("[]")).toEqual({ views: true, dashboards: true });
	});

	test("a throwing store never breaks the sidebar", () => {
		const hostile = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(readNavSections("u1", hostile)).toEqual({});
		expect(() =>
			writeNavSections("u1", { views: false }, hostile),
		).not.toThrow();
	});
});
