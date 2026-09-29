import { describe, expect, test } from "vitest";
import {
	navSectionsKey,
	parseCollapsed,
	readCollapsed,
	writeCollapsed,
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
		writeCollapsed("u1", new Set(["views"]), store);
		expect([...readCollapsed("u1", store)]).toEqual(["views"]);
		expect(readCollapsed("u2", store).size).toBe(0);
		expect(store.getItem(navSectionsKey("u1"))).toBe('["views"]');
	});

	test("garbage and unknown sections read as all open", () => {
		expect(parseCollapsed("not json").size).toBe(0);
		expect(parseCollapsed('{"views":true}').size).toBe(0);
		expect([...parseCollapsed('["dashboards","lists","__proto__"]')]).toEqual([
			"dashboards",
		]);
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
		expect(readCollapsed("u1", hostile).size).toBe(0);
		expect(() =>
			writeCollapsed("u1", new Set(["views"]), hostile),
		).not.toThrow();
	});
});
