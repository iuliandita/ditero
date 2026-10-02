import { useZero } from "@rocicorp/zero/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { createHintStore, dismissSyntaxHint, FRESH_HINTS } from "./hints.ts";
import {
	type NativeAccount,
	NativeAccountContext,
	useAccountStorageScope,
} from "./native-account.tsx";
import { readNavSections, writeNavSections } from "./nav-sections.ts";

vi.mock("@rocicorp/zero/react", () => ({
	useZero: vi.fn(() => ({ userID: "u1" })),
}));

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
	test("native convenience stores isolate the same account across servers and browser", () => {
		function scopeFor(account: NativeAccount | null): string {
			let resolved = "";
			function Probe() {
				resolved = useAccountStorageScope();
				return null;
			}
			renderToStaticMarkup(
				createElement(
					NativeAccountContext.Provider,
					{ value: account },
					createElement(Probe),
				),
			);
			return resolved;
		}
		const firstOrigin = "https://first.example";
		const secondOrigin = "https://second.example";
		const profile = {
			id: "u1",
			name: "Fixture user",
			email: "fixture@example.com",
		};
		const changeServer = async () => undefined;
		const first = scopeFor({
			profile,
			origin: firstOrigin,
			storageScope: `native:["${firstOrigin}","u1"]`,
			changeServer,
		});
		const second = scopeFor({
			profile,
			origin: secondOrigin,
			storageScope: `native:["${secondOrigin}","u1"]`,
			changeServer,
		});
		const browser = scopeFor(null);
		expect(browser).toBe("u1");
		expect(vi.mocked(useZero)).toHaveBeenCalledTimes(3);
		const storage = memory();
		recordRecent(browser, { kind: "list", id: "browser-list" }, storage);
		recordRecent(first, { kind: "task", id: "first-task" }, storage);
		recordRecent(second, { kind: "task", id: "second-task" }, storage);
		expect(loadRecents(first, storage)).toEqual([
			{ kind: "task", id: "first-task" },
		]);
		expect(loadRecents(second, storage)).toEqual([
			{ kind: "task", id: "second-task" },
		]);
		expect(loadRecents(browser, storage)).toEqual([
			{ kind: "list", id: "browser-list" },
		]);
		expect(storage.getItem("ditero.recents.u1")).toBe(
			JSON.stringify([{ kind: "list", id: "browser-list" }]),
		);
		const hints = createHintStore(() => storage);
		hints.update(first, dismissSyntaxHint);
		expect(createHintStore(() => storage).get(first).syntaxDismissed).toBe(
			true,
		);
		expect(hints.get(second)).toEqual(FRESH_HINTS);
		expect(hints.get(browser)).toEqual(FRESH_HINTS);
		writeNavSections(first, { views: false }, storage);
		writeNavSections(second, { dashboards: true }, storage);
		expect(readNavSections(first, storage)).toEqual({ views: false });
		expect(readNavSections(second, storage)).toEqual({ dashboards: true });
		expect(readNavSections(browser, storage)).toEqual({});
	});

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
