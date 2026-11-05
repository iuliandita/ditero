import { describe, expect, test } from "vitest";
import { dateParserFor, parseQuickAdd } from "../../domain/quick-add.ts";
import { m } from "../../paraglide/messages.js";
import { locales } from "../../paraglide/runtime.js";
import { splitAroundKey } from "../components/ui/key-text.tsx";
import {
	createHintStore,
	FRESH_HINTS,
	hintsKey,
	markShortcutsSeen,
	NO_USER_HINTS,
	parseHints,
	readHints,
	shortcutHintVisible,
	syntaxTokens,
} from "./hints.ts";

function memoryStorage(seed: Record<string, string> = {}) {
	const data = new Map(Object.entries(seed));
	return {
		data,
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => {
			data.set(k, v);
		},
	};
}

describe("shortcut hint", () => {
	test("needs a fine pointer and an unopened cheat sheet", () => {
		expect(shortcutHintVisible(FRESH_HINTS, true)).toBe(true);
		expect(shortcutHintVisible(FRESH_HINTS, false)).toBe(false);
		expect(shortcutHintVisible(markShortcutsSeen(FRESH_HINTS), true)).toBe(
			false,
		);
	});
});

describe("stored hints", () => {
	test("unreadable or hostile values resolve to a fresh state", () => {
		expect(parseHints(null)).toEqual(FRESH_HINTS);
		expect(parseHints("{nope")).toEqual(FRESH_HINTS);
		expect(parseHints("42")).toEqual(FRESH_HINTS);
		expect(parseHints(JSON.stringify({ shortcutsSeen: "yes", x: 1 }))).toEqual(
			FRESH_HINTS,
		);
		expect(parseHints(JSON.stringify({ shortcutsSeen: true }))).toEqual({
			shortcutsSeen: true,
		});
	});

	test("a throwing storage never breaks the read", () => {
		const broken = {
			getItem: () => {
				throw new Error("denied");
			},
			setItem: () => {
				throw new Error("denied");
			},
		};
		expect(readHints("u1", broken)).toEqual(FRESH_HINTS);
		const store = createHintStore(() => broken);
		store.update("u1", markShortcutsSeen);
		expect(store.get("u1").shortcutsSeen).toBe(true);
	});

	test("without a user id nothing is read, written, or shown", () => {
		let reads = 0;
		const storage = memoryStorage({ [hintsKey("")]: JSON.stringify({}) });
		const store = createHintStore(() => {
			reads++;
			return storage;
		});
		const h = store.get("");
		expect(h).toBe(NO_USER_HINTS);
		expect(shortcutHintVisible(h, true)).toBe(false);
		store.update("", () => FRESH_HINTS);
		expect(reads).toBe(0);
		expect([...storage.data.keys()]).toEqual([hintsKey("")]);
	});

	test("the store persists per user and notifies once per real change", () => {
		const storage = memoryStorage();
		const store = createHintStore(() => storage);
		let calls = 0;
		store.subscribe(() => {
			calls++;
		});
		store.update("u1", markShortcutsSeen);
		store.update("u1", markShortcutsSeen);
		expect(calls).toBe(1);
		expect(parseHints(storage.data.get(hintsKey("u1")) ?? null)).toEqual({
			...FRESH_HINTS,
			shortcutsSeen: true,
		});
		expect(store.get("u2")).toEqual(FRESH_HINTS);
		expect(createHintStore(() => storage).get("u1").shortcutsSeen).toBe(true);
	});
});

// The hint must never advertise grammar the parser rejects in that locale.
describe.each(locales)("advertised syntax parses in %s", (locale) => {
	const hasDates = dateParserFor(locale) != null;
	const dateWord = hasDates ? m.quickadd_example_date({}, { locale }) : null;
	const word = m.syntax_hint_word({}, { locale });

	test("every legend token parses as its own type", () => {
		const tokens = syntaxTokens(dateWord, word);
		expect(tokens.some((t) => t.type === "date")).toBe(hasDates);
		for (const t of tokens) {
			const parsed = parseQuickAdd(`x ${t.token}`, undefined, locale);
			expect(parsed.tokens.map((p) => [p.type, p.text])).toContainEqual([
				t.type,
				t.token,
			]);
		}
	});

	test("keycap sentences carry exactly one key slot", () => {
		const render = (key: string) => m.shortcut_hint({ key }, { locale });
		const [before, after] = splitAroundKey(render);
		expect(`${before}K${after}`).toBe(render("K"));
	});
});
