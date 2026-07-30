import { describe, expect, test } from "vitest";
import { m } from "../paraglide/messages.js";
import { dateParserFor, parseQuickAdd } from "./quick-add.ts";

const NOW = new Date(2024, 0, 15, 9, 0, 0); // Mon Jan 15 2024, 09:00 local
// chrono carries the reference time-of-day onto a bare date word.
const TOMORROW = new Date(2024, 0, 16, 9, 0, 0);

// Locales chrono ships a parser for, and the date word each one advertises.
const WITH_PARSER: [locale: string, phrase: string][] = [
	["en", "buy milk tomorrow"],
	["de", "Milch kaufen morgen"],
	["es", "comprar leche mañana"],
	["fr", "acheter du lait demain"],
];
const WITHOUT_PARSER = ["ro", "ar"];

describe("quick-add date parsing follows the locale", () => {
	test.each(WITH_PARSER)("%s parses its own date word", (locale, phrase) => {
		const r = parseQuickAdd(phrase, NOW, locale);
		expect(r.dueAt).toEqual(TOMORROW);
		expect(r.tokens.some((t) => t.type === "date")).toBe(true);
	});

	test.each(WITHOUT_PARSER)("%s has no parser and dates stay off", (locale) => {
		expect(dateParserFor(locale)).toBeNull();
		const r = parseQuickAdd("cumpără lapte mâine", NOW, locale);
		expect(r.dueAt).toBeNull();
		expect(r.tokens.some((t) => t.type === "date")).toBe(false);
	});

	// The reason those locales are OFF rather than falling back to English.
	// "sat" is Romanian for village and "sun" is "I call"; the English parser
	// reads both as weekdays and would silently date the task.
	test("no English fallback silently dates ordinary Romanian words", () => {
		expect(parseQuickAdd("mergem in sat", NOW, "ro").dueAt).toBeNull();
		expect(parseQuickAdd("sun la 5 pm", NOW, "ro").dueAt).toBeNull();
		// Same input under the English parser is exactly what we are avoiding.
		expect(parseQuickAdd("mergem in sat", NOW, "en").dueAt).not.toBeNull();
		expect(parseQuickAdd("sun la 5 pm", NOW, "en").dueAt).not.toBeNull();
	});

	test("an unknown locale disables dates rather than guessing English", () => {
		expect(dateParserFor("xx")).toBeNull();
		expect(parseQuickAdd("buy milk tomorrow", NOW, "xx").dueAt).toBeNull();
	});

	// The locale arrives from the runtime, so a prototype key must not resolve
	// through the chain into something that is not a parser.
	test("an inherited Object key is not a parser", () => {
		expect(dateParserFor("constructor")).toBeNull();
		expect(dateParserFor("toString")).toBeNull();
		expect(
			parseQuickAdd("buy milk tomorrow", NOW, "toString").dueAt,
		).toBeNull();
	});

	// Sigils are grammar, not language: they must keep working everywhere,
	// including the locales where date parsing is off.
	test("sigils still parse on a locale with no date parser", () => {
		const r = parseQuickAdd("cumpără lapte p1 #casă ~piață", NOW, "ro");
		expect(r.priority).toBe(3);
		expect(r.labels).toEqual(["casă"]);
		expect(r.listName).toBe("piață");
		expect(r.title).toBe("cumpără lapte");
	});
});

// #90, found while fixing this issue: the sigil is grammar but the word after
// it is user content, and the ASCII `\w` class truncated it. This is not
// specific to non-Latin scripts -- German and Spanish were affected too.
describe("labels and lists keep their non-ASCII letters", () => {
	test.each([
		["#casă", "casă"],
		["#Küche", "Küche"],
		["#уборка", "уборка"],
		["#مهام", "مهام"],
		["#año-nuevo", "año-nuevo"],
	])("%s captures the whole word", (typed, expected) => {
		expect(parseQuickAdd(`task ${typed}`, NOW, "en").labels).toEqual([
			expected,
		]);
	});

	test("list names too", () => {
		const r = parseQuickAdd("lapte ~piață", NOW, "ro");
		expect(r.listName).toBe("piață");
		expect(r.title).toBe("lapte");
	});

	test("ASCII labels are unchanged", () => {
		expect(parseQuickAdd("task #home-office", NOW, "en").labels).toEqual([
			"home-office",
		]);
	});
});

// The hint promises a syntax; this asserts the promise is kept. A translator
// changing the example to a word chrono does not know would otherwise ship a
// placeholder that silently fails.
describe("the advertised date example is actually parseable", () => {
	test.each(
		WITH_PARSER.map(([locale]) => locale),
	)("%s example round-trips through its own parser", (locale) => {
		const example = m.quickadd_example_date({}, { locale: locale as "en" });
		const r = parseQuickAdd(`task ${example}`, NOW, locale);
		expect(r.dueAt, `"${example}" did not parse in ${locale}`).not.toBeNull();
		expect(r.title).toBe("task");
	});

	test.each(WITHOUT_PARSER)("%s advertises no date example", (locale) => {
		const hint = m.quickadd_placeholder_nodate(
			{ priority: "p2", label: "#store", list: "~groceries" },
			{ locale: locale as "ro" },
		);
		expect(hint).not.toContain("{date}");
		expect(hint).toContain("p2");
	});
});
