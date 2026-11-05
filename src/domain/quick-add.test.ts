import { describe, expect, test } from "vitest";
import {
	type KeptSpan,
	parseLeadingAmount,
	parseQuickAdd,
	shiftKeptSpans,
} from "./quick-add.ts";

const NOW = new Date(2024, 0, 15, 9, 0, 0); // Mon Jan 15 2024, 09:00 local

describe("parseQuickAdd", () => {
	test("date + time -> title strips trailing date, dueAllDay false", () => {
		const r = parseQuickAdd("buy milk tomorrow 5pm", NOW);
		expect(r.title).toBe("buy milk");
		expect(r.dueAt).toEqual(new Date(2024, 0, 16, 17, 0, 0));
		expect(r.dueAllDay).toBe(false);
	});

	test("date without time -> dueAllDay true", () => {
		const r = parseQuickAdd("buy milk tomorrow", NOW);
		expect(r.title).toBe("buy milk");
		expect(r.dueAt).toEqual(new Date(2024, 0, 16, 9, 0, 0));
		expect(r.dueAllDay).toBe(true);
	});

	test("priority + label", () => {
		const r = parseQuickAdd("call mom p1 #family", NOW);
		expect(r.priority).toBe(3);
		expect(r.labels).toEqual(["family"]);
		expect(r.title).toBe("call mom");
		expect(r.dueAt).toBeNull();
	});

	test("list sigil", () => {
		const r = parseQuickAdd("eggs ~groceries", NOW);
		expect(r.listName).toBe("groceries");
		expect(r.title).toBe("eggs");
	});

	test("priority + two labels + trailing weekday", () => {
		const r = parseQuickAdd("p1 fix boiler #home #urgent friday", NOW);
		expect(r.priority).toBe(3);
		expect(r.labels).toEqual(["home", "urgent"]);
		expect(r.title).toBe("fix boiler");
		expect(r.dueAt).toEqual(new Date(2024, 0, 19, 12, 0, 0));
		expect(r.dueAllDay).toBe(true);
	});

	test("plain text with no tokens is passed through unchanged", () => {
		const r = parseQuickAdd("plain task", NOW);
		expect(r.title).toBe("plain task");
		expect(r.dueAt).toBeNull();
		expect(r.priority).toBe(0);
		expect(r.labels).toEqual([]);
		expect(r.listName).toBeNull();
		expect(r.tokens).toEqual([]);
	});

	test("p1 followed by @ is not a priority token", () => {
		const r = parseQuickAdd("email p1@example.com", NOW);
		expect(r.priority).toBe(0);
		expect(r.title).toBe("email p1@example.com");
		expect(r.tokens).toEqual([]);
	});

	test("bare # sigil produces no token and does not throw", () => {
		expect(() => parseQuickAdd("#", NOW)).not.toThrow();
		const r = parseQuickAdd("#", NOW);
		expect(r.labels).toEqual([]);
		expect(r.title).toBe("#");
	});

	test("trailing bare ~ sigil produces no token and does not throw", () => {
		expect(() => parseQuickAdd("water plants ~", NOW)).not.toThrow();
		const r = parseQuickAdd("water plants ~", NOW);
		expect(r.listName).toBeNull();
		expect(r.title).toBe("water plants ~");
	});

	test("p4 is consumed and maps to priority 0", () => {
		const r = parseQuickAdd("wash car p4", NOW);
		expect(r.priority).toBe(0);
		expect(r.title).toBe("wash car");
		expect(r.tokens).toEqual([
			{ type: "priority", text: "p4", start: 9, end: 11 },
		]);
	});

	test("token spans are offsets into the original input", () => {
		const r = parseQuickAdd("call mom p1 #family", NOW);
		const priorityToken = r.tokens.find((t) => t.type === "priority");
		const labelToken = r.tokens.find((t) => t.type === "label");
		expect(priorityToken).toEqual({
			type: "priority",
			text: "p1",
			start: 9,
			end: 11,
		});
		expect(labelToken).toEqual({
			type: "label",
			text: "#family",
			start: 12,
			end: 19,
		});
		expect("call mom p1 #family".slice(9, 11)).toBe("p1");
		expect("call mom p1 #family".slice(12, 19)).toBe("#family");
	});

	test("date token span matches original input coordinates", () => {
		const r = parseQuickAdd("buy milk tomorrow 5pm", NOW);
		const dateToken = r.tokens.find((t) => t.type === "date");
		expect(dateToken).toEqual({
			type: "date",
			text: "tomorrow 5pm",
			start: 9,
			end: 21,
		});
	});

	test("never throws on garbage input", () => {
		expect(() => parseQuickAdd("", NOW)).not.toThrow();
		expect(() => parseQuickAdd("   ", NOW)).not.toThrow();
		expect(() => parseQuickAdd("###~~~p9p0", NOW)).not.toThrow();
	});

	test("empty input yields empty title and empty tokens", () => {
		const r = parseQuickAdd("", NOW);
		expect(r.title).toBe("");
		expect(r.dueAt).toBeNull();
		expect(r.tokens).toEqual([]);
	});

	test("only the last date match is treated as the due date", () => {
		const r = parseQuickAdd("meet friday about tomorrow's agenda", NOW);
		expect(r.dueAt).toEqual(new Date(2024, 0, 16, 9, 0, 0));
	});

	test("non-string input degrades to an empty parse without throwing", () => {
		const empty = {
			title: "",
			dueAt: null,
			dueAllDay: true,
			priority: 0,
			labels: [],
			listName: null,
			tokens: [],
		};
		expect(() => parseQuickAdd(null as never, NOW)).not.toThrow();
		expect(parseQuickAdd(null as never, NOW)).toEqual(empty);
		expect(parseQuickAdd(undefined as never, NOW)).toEqual(empty);
	});

	test("tokens are returned sorted by start ascending", () => {
		const r = parseQuickAdd("#home fix tomorrow p1", NOW);
		const starts = r.tokens.map((t) => t.start);
		expect(starts).toEqual([...starts].sort((a, b) => a - b));
		expect(r.tokens.map((t) => t.type)).toEqual(["label", "date", "priority"]);
		expect(starts).toEqual([0, 10, 19]);
	});

	test("first priority wins, both duplicates consumed and tokenized", () => {
		const r = parseQuickAdd("p1 task p3", NOW);
		expect(r.priority).toBe(3);
		expect(r.title).toBe("task");
		expect(r.tokens.map((t) => t.text)).toEqual(["p1", "p3"]);
	});

	test("first list wins, both duplicates consumed and tokenized", () => {
		const r = parseQuickAdd("eggs ~home ~work", NOW);
		expect(r.listName).toBe("home");
		expect(r.title).toBe("eggs");
		expect(r.tokens.map((t) => t.text)).toEqual(["~home", "~work"]);
	});

	test.each([
		"Queued 55ccea73-813d-406e-95c3-9b97999f3fcd",
		"Ship build v2-3d",
		"Fix 3dprinter",
	])("a date glued to a word stays in the title: %s", (input) => {
		const r = parseQuickAdd(input, NOW);
		expect(r.title).toBe(input);
		expect(r.dueAt).toBeNull();
	});

	test("a standalone duration and an ISO date still parse", () => {
		expect(parseQuickAdd("water plants in 3d", NOW).title).toBe("water plants");
		const iso = parseQuickAdd("renew pass 2024-03-01", NOW);
		expect(iso.title).toBe("renew pass");
		expect(iso.dueAt).toEqual(new Date(2024, 2, 1, 12, 0, 0));
	});
});

test("known destinations use the longest full name and leave unresolved text visible", () => {
	const names = ["Home", "Home plans", "Café list"];
	const parsed = parseQuickAdd("Buy stamps ~home plans p1", NOW, "en", names);
	expect(parsed.title).toBe("Buy stamps");
	expect(parsed.listName).toBe("home plans");
	expect(parsed.tokens.find((token) => token.type === "list")?.text).toBe(
		"~home plans",
	);
	expect(parseQuickAdd("Buy ~cafe list", NOW, "en", names).listName).toBe(
		"cafe list",
	);
	expect(parseQuickAdd("Buy ~Unknown plans", NOW, "en", names).listName).toBe(
		"Unknown",
	);
});

test.each([
	["bake ~ 20 cookies", ["Home"], "bake ~ 20 cookies", null],
	[
		"Read https://x.org/~bob/notes",
		["Home"],
		"Read https://x.org/~bob/notes",
		null,
	],
	["eggs ~Home ~Work", ["Home", "Work"], "eggs", "Home"],
	["buy ~Unknown milk tomorrow", ["Home"], "buy milk tomorrow", "Unknown"],
	["buy ~Home, please", ["Home"], "buy , please", "Home"],
	["buy ~Home plans later", ["Home", "Home plans"], "buy later", "Home plans"],
	["buy ~Cafe\u0301 list now", ["Café list"], "buy now", "Cafe\u0301 list"],
	["شراء ~مَنْزِل كبير", ["منزل"], "شراء كبير", "مَنْزِل"],
	["buy ~Home", ["Home", "Home"], "buy", "Home"],
] as const)("preserves capture around list tokens: %s", (input, names, title, name) => {
	const result = parseQuickAdd(input, NOW, "ro", names);
	expect(result.title).toBe(title);
	expect(result.listName).toBe(name);
});

describe("tokens turned back into words", () => {
	const spanOf = (input: string, text: string, nth = 0): KeptSpan => {
		let start = -1;
		for (let i = 0; i <= nth; i++) start = input.indexOf(text, start + 1);
		return { start, end: start + text.length, text };
	};

	test.each([
		["Pay rent p1", "p1", "priority"],
		["Buy milk #Home", "#Home", "label"],
		["Call mum tomorrow", "tomorrow", "date"],
		["Stamps ~Post", "~Post", "list"],
	])("%s keeps %s as title text", (input, text, type) => {
		const kept = parseQuickAdd(input, NOW, "en", undefined, [
			spanOf(input, text),
		]);
		expect(kept.tokens).toEqual([]);
		expect(kept.title).toBe(input);
		expect(parseQuickAdd(input, NOW, "en").tokens.map((t) => t.type)).toEqual([
			type,
		]);
	});

	test("only the named token stays prose", () => {
		const input = "Pay rent p1 #home";
		const r = parseQuickAdd(input, NOW, "en", undefined, [spanOf(input, "p1")]);
		expect(r.title).toBe("Pay rent p1");
		expect(r.priority).toBe(0);
		expect(r.labels).toEqual(["home"]);
	});

	test("a kept list token is not read again as a date", () => {
		const input = "Buy flowers ~Friday";
		const r = parseQuickAdd(
			input,
			NOW,
			"en",
			["Friday"],
			[spanOf(input, "~Friday")],
		);
		expect(r.title).toBe("Buy flowers ~Friday");
		expect(r.dueAt).toBeNull();
		expect(r.listName).toBeNull();
		expect(r.tokens).toEqual([]);
	});

	test("a kept label is not read again as a priority", () => {
		const input = "Book #p1";
		const r = parseQuickAdd(input, NOW, "en", undefined, [
			spanOf(input, "#p1"),
		]);
		expect(r.title).toBe("Book #p1");
		expect(r.priority).toBe(0);
		expect(r.labels).toEqual([]);
	});

	test("keeping one of two identical tokens leaves the other read", () => {
		const input = "a p1 b p1";
		const r = parseQuickAdd(input, NOW, "en", undefined, [
			spanOf(input, "p1", 1),
		]);
		expect(r.title).toBe("a b p1");
		expect(r.tokens.map((t) => [t.start, t.text])).toEqual([[2, "p1"]]);
		const first = parseQuickAdd(input, NOW, "en", undefined, [
			spanOf(input, "p1", 0),
		]);
		expect(first.title).toBe("a p1 b");
		expect(first.tokens.map((t) => t.start)).toEqual([7]);
	});

	test("a span that no longer matches the input is ignored", () => {
		const r = parseQuickAdd("Pay rent p1", NOW, "en", undefined, [
			{ start: 0, end: 2, text: "p1" },
			{ start: 40, end: 42, text: "p1" },
		]);
		expect(r.priority).toBe(3);
		expect(r.title).toBe("Pay rent");
	});
});

describe("shiftKeptSpans", () => {
	const kept: KeptSpan = { start: 4, end: 6, text: "p1" };

	test("typing before the span shifts it", () => {
		expect(shiftKeptSpans("Buy p1", "Buy milk p1", [kept])).toEqual([
			{ start: 9, end: 11, text: "p1" },
		]);
	});

	test("typing after the span leaves it", () => {
		expect(shiftKeptSpans("Buy p1", "Buy p1 now", [kept])).toEqual([kept]);
	});

	test("deleting before the span shifts it back", () => {
		const prev: KeptSpan = { start: 9, end: 11, text: "p1" };
		expect(shiftKeptSpans("Buy milk p1", "Buy p1", [prev])).toEqual([kept]);
	});

	test("an edit inside the span drops it", () => {
		expect(shiftKeptSpans("Buy p1", "Buy p2", [kept])).toEqual([]);
		expect(shiftKeptSpans("Buy p1", "Buy ", [kept])).toEqual([]);
	});

	test("a span stays valid through repeated identical text", () => {
		const prev = "a p1 b p1";
		const second: KeptSpan = { start: 7, end: 9, text: "p1" };
		expect(shiftKeptSpans(prev, "a p1 bb p1", [second])).toEqual([
			{ start: 8, end: 10, text: "p1" },
		]);
		expect(shiftKeptSpans(prev, "a b p1", [second])).toEqual([
			{ start: 4, end: 6, text: "p1" },
		]);
	});

	test("edits before a kept span keep it out of the parse", () => {
		const prev = "Book #p1";
		const next = "Please book #p1";
		const spans = shiftKeptSpans(prev, next, [
			{ start: 5, end: 8, text: "#p1" },
		]);
		const r = parseQuickAdd(next, NOW, "en", undefined, spans);
		expect(r.title).toBe("Please book #p1");
		expect(r.priority).toBe(0);
	});
});

describe("parseLeadingAmount", () => {
	test.each([
		["2 milk", "2", "", "milk", "2"],
		["2x eggs", "2", "", "eggs", "2x"],
		["500 g flour", "500", "g", "flour", "500 g"],
		["500g flour", "500", "g", "flour", "500g"],
		["1,5 L oat milk", "1,5", "L", "oat milk", "1,5 L"],
		["  3   bananas", "3", "", "bananas", "3"],
		["2 lemons", "2", "", "lemons", "2"],
	])("%j reads as an amount", (input, quantity, unit, title, chip) => {
		const r = parseLeadingAmount(input);
		expect(r).toMatchObject({ quantity, unit, title });
		expect(r && input.slice(r.token.start, r.token.end)).toBe(chip);
		expect(r?.token).toMatchObject({ type: "quantity", text: chip });
	});

	test.each([
		"milk",
		"7up",
		"2% milk",
		"2",
		"2 ",
		"0 apples",
		"1234567 apples",
		"milk 2",
		"",
	])("%j stays a plain name", (input) => {
		expect(parseLeadingAmount(input)).toBeNull();
	});
});
