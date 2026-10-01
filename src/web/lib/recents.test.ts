import { describe, expect, test } from "vitest";
import {
	loadRecents,
	parseRecents,
	pushRecent,
	RECENTS_MAX,
	recentsKey,
	recordRecent,
} from "./recents.ts";

function memory() {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => {
			data.set(k, v);
		},
	};
}

const throwing = {
	getItem: () => {
		throw new Error("SecurityError");
	},
	setItem: () => {
		throw new Error("QuotaExceededError");
	},
};

describe("recents", () => {
	test("never keys an empty user id", () => {
		expect(recentsKey("")).toBeNull();
		expect(recentsKey(null)).toBeNull();
		expect(recentsKey("u1")).toBe("ditero.recents.u1");
		const s = memory();
		recordRecent("", { kind: "list", id: "l1" }, s);
		expect(s.data.size).toBe(0);
		expect(loadRecents("", s)).toEqual([]);
	});

	test("most recent first, deduplicated by kind and id", () => {
		const list = pushRecent(
			pushRecent(pushRecent([], { kind: "list", id: "a" }), {
				kind: "task",
				id: "a",
			}),
			{ kind: "list", id: "a" },
		);
		expect(list).toEqual([
			{ kind: "list", id: "a" },
			{ kind: "task", id: "a" },
		]);
	});

	test("caps the history", () => {
		let list: ReturnType<typeof pushRecent> = [];
		for (let i = 0; i < RECENTS_MAX + 3; i++)
			list = pushRecent(list, { kind: "task", id: `t${i}` });
		expect(list).toHaveLength(RECENTS_MAX);
		expect(list[0].id).toBe(`t${RECENTS_MAX + 2}`);
	});

	test("keeps each user's history apart", () => {
		const s = memory();
		recordRecent("u1", { kind: "view", id: "today" }, s);
		recordRecent("u2", { kind: "list", id: "l2" }, s);
		expect(loadRecents("u1", s)).toEqual([{ kind: "view", id: "today" }]);
		expect(loadRecents("u2", s)).toEqual([{ kind: "list", id: "l2" }]);
	});

	test("drops malformed stored entries", () => {
		expect(parseRecents("not json")).toEqual([]);
		expect(parseRecents('{"kind":"list"}')).toEqual([]);
		expect(
			parseRecents(
				JSON.stringify([
					{ kind: "list", id: "ok" },
					{ kind: "folder", id: "x" },
					{ kind: "task", id: "" },
					null,
					{ kind: "task", id: 3 },
				]),
			),
		).toEqual([{ kind: "list", id: "ok" }]);
	});

	test("a throwing storage degrades to no recents", () => {
		expect(() =>
			recordRecent("u1", { kind: "list", id: "l1" }, throwing),
		).not.toThrow();
		expect(loadRecents("u1", throwing)).toEqual([]);
		expect(loadRecents("u1", null)).toEqual([]);
	});
});
