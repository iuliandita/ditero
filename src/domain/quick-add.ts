import * as chrono from "chrono-node";

// chrono ships parsers for some locales and not others. Where one exists the
// user writes dates in their own language; where none does, natural-language
// dates are OFF rather than falling back to English.
//
// Falling back is not the safe default it looks like. The English parser reads
// ordinary Romanian words as dates: "mergem in sat" (we go to the village)
// matches "sat" -> Saturday, and "sun la 5" (I call at 5) matches "sun" ->
// Sunday. That silently attaches a due date to a task the user never dated,
// which is worse than not parsing at all. Users on those locales set dates with
// the picker; the placeholder stops advertising a date example.
type DateParser = { parse: typeof chrono.parse };

const DATE_PARSERS: Record<string, DateParser> = {
	en: chrono,
	de: chrono.de,
	es: chrono.es,
	fr: chrono.fr,
};

// Exported so the input hint can drop its date example on locales with no
// parser instead of promising syntax that will not work.
export function dateParserFor(locale: string): DateParser | null {
	return Object.hasOwn(DATE_PARSERS, locale) ? DATE_PARSERS[locale] : null;
}

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

// The sigil is grammar; the word after it is user content, so the character
// class has to be Unicode. `\w` is ASCII-only and truncated every non-English
// label -- "#casă" captured "cas", "#Küche" captured "K", "#уборка" matched
// nothing at all (#90). \p{L}\p{N} is a strict superset of the old behaviour.
const LABEL_RE = /#([\p{L}\p{N}_-]+)/gu;
const LIST_RE = /~([\p{L}\p{N}_-]+)/gu;
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
	locale = "en",
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

	const parser = dateParserFor(locale);
	const dateResults = parser
		? parser.parse(chars.join(""), now, { forwardDate: true })
		: [];
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
