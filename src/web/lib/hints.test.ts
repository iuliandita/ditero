import { describe, expect, test } from "vitest";
import { dateParserFor, parseQuickAdd } from "../../domain/quick-add.ts";
import { m } from "../../paraglide/messages.js";
import { locales } from "../../paraglide/runtime.js";
import { splitAroundKey } from "../components/ui/key-text.tsx";
import {
	createHintStore,
	dismissSyntaxHint,
	FRESH_HINTS,
	type Hints,
	hintsKey,
	markShortcutsSeen,
	parseHints,
	readHints,
	recordSyntaxUse,
	SYNTAX_HINT_USES,
	shortcutHintVisible,
	syntaxHintVisible,
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

describe("syntax hint retirement", () => {
	test("shows until three quick adds actually used a token", () => {
		let h: Hints = FRESH_HINTS;
		for (let i = 0; i < SYNTAX_HINT_USES; i++) {
			expect(syntaxHintVisible(h)).toBe(true);
			h = recordSyntaxUse(h, 1);
		}
		expect(syntaxHintVisible(h)).toBe(false);
	});

	test("a quick add with no parsed token does not count", () => {
		expect(recordSyntaxUse(FRESH_HINTS, 0)).toBe(FRESH_HINTS);
	});

	test("dismissing retires it immediately", () => {
		expect(syntaxHintVisible(dismissSyntaxHint(FRESH_HINTS))).toBe(false);
	});
});

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
		expect(
			parseHints(
				JSON.stringify({ syntaxUses: -2, syntaxDismissed: "yes", x: 1 }),
			),
		).toEqual(FRESH_HINTS);
		expect(parseHints(JSON.stringify({ syntaxUses: 1e9 })).syntaxUses).toBe(
			SYNTAX_HINT_USES,
		);
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
		store.update("u1", dismissSyntaxHint);
		expect(store.get("u1").syntaxDismissed).toBe(true);
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

	test("the example line yields exactly what it shows", () => {
		const sentence = hasDates
			? m.syntax_hint_example(
					{ date: dateWord ?? "", priority: "p1" },
					{ locale },
				)
			: m.syntax_hint_example_nodate({ priority: "p1" }, { locale });
		const example = sentence.slice(sentence.indexOf(":") + 1).trim();
		const parsed = parseQuickAdd(example, undefined, locale);
		const types = parsed.tokens.map((t) => t.type).sort();
		expect(types).toEqual(
			hasDates ? ["date", "label", "priority"] : ["label", "priority"],
		);
		expect(parsed.priority).toBe(3);
		expect(parsed.title).not.toMatch(/[#~]|p1/);
		expect(parsed.title.length).toBeGreaterThan(0);
	});

	test("keycap sentences carry exactly one key slot", () => {
		for (const render of [
			(key: string) => m.shortcut_hint({ key }, { locale }),
			(key: string) => m.syntax_hint_inline_lead({ key }, { locale }),
		]) {
			const [before, after] = splitAroundKey(render);
			expect(`${before}K${after}`).toBe(render("K"));
		}
	});
});
