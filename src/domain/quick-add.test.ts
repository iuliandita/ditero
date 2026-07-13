import { describe, expect, test } from "vitest";
import { parseQuickAdd } from "./quick-add.ts";

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
});
