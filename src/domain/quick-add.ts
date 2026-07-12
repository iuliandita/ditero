import * as chrono from "chrono-node";

export type QuickAddToken = {
	type: "date" | "priority" | "label" | "list";
	text: string;
	start: number;
	end: number;
};

export type QuickAddParse = {
	title: string;
	dueAt: Date | null;
	dueAllDay: boolean;
	priority: 0 | 1 | 2 | 3;
	labels: string[];
	listName: string | null;
	tokens: QuickAddToken[];
};

const LABEL_RE = /#([\w-]+)/g;
const LIST_RE = /~([\w-]+)/g;
const PRIORITY_RE = /\bp([1-4])\b(?!@)/g;
const PRIORITY_RANK: Record<string, 0 | 1 | 2 | 3> = {
	"1": 3,
	"2": 2,
	"3": 1,
	"4": 0,
};

const emptyParse = (): QuickAddParse => ({
	title: "",
	dueAt: null,
	dueAllDay: true,
	priority: 0,
	labels: [],
	listName: null,
	tokens: [],
});

export function parseQuickAdd(
	input: string,
	now: Date = new Date(),
): QuickAddParse {
	// Task 10 feeds an onChange value; guard the never-throws contract.
	if (typeof input !== "string") return emptyParse();
	const chars = input.split("");
	const mask = (start: number, end: number) => {
		for (let i = start; i < end; i++) chars[i] = " ";
	};

	const tokens: QuickAddToken[] = [];
	const labels: string[] = [];
	let listName: string | null = null;
	let priority: 0 | 1 | 2 | 3 = 0;
	let prioritySeen = false;

	for (const m of chars.join("").matchAll(LABEL_RE)) {
		const start = m.index;
		const end = start + m[0].length;
		labels.push(m[1]);
		tokens.push({ type: "label", text: m[0], start, end });
		mask(start, end);
	}

	for (const m of chars.join("").matchAll(LIST_RE)) {
		const start = m.index;
		const end = start + m[0].length;
		// First list wins; later dupes still consumed+tokenized so they don't leak into title.
		if (listName === null) listName = m[1];
		tokens.push({ type: "list", text: m[0], start, end });
		mask(start, end);
	}

	for (const m of chars.join("").matchAll(PRIORITY_RE)) {
		const start = m.index;
		const end = start + m[0].length;
		// First priority wins; later dupes still consumed+tokenized so they don't leak into title.
		if (!prioritySeen) {
			priority = PRIORITY_RANK[m[1]];
			prioritySeen = true;
		}
		tokens.push({ type: "priority", text: m[0], start, end });
		mask(start, end);
	}

	const dateResults = chrono.parse(chars.join(""), now, { forwardDate: true });
	let dueAt: Date | null = null;
	let dueAllDay = true;
	if (dateResults.length > 0) {
		const last = dateResults[dateResults.length - 1];
		const start = last.index;
		const end = start + last.text.length;
		dueAt = last.date();
		dueAllDay = !last.start.isCertain("hour");
		tokens.push({ type: "date", text: last.text, start, end });
		mask(start, end);
	}

	const title = chars.join("").split(/\s+/).filter(Boolean).join(" ");

	// Task 10's TokenChips walks tokens left-to-right; return sorted by span start.
	tokens.sort((a, b) => a.start - b.start);

	return { title, dueAt, dueAllDay, priority, labels, listName, tokens };
}
