import * as chrono from "chrono-node";
import { isValidQuantity, isValidUnit } from "./quantity.ts";

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
	type: "date" | "priority" | "label" | "list" | "quantity";
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
const PRIORITY_RE = /\bp([1-4])\b(?!@)/g;
const PRIORITY_RANK: Record<string, 0 | 1 | 2 | 3> = {
	"1": 3,
	"2": 2,
	"3": 1,
	"4": 0,
};

/** Stored priority level for a consumed `p1`-`p4` token, else null. */
export function priorityFromToken(text: string): 0 | 1 | 2 | 3 | null {
	const match = /^p([1-4])$/.exec(text);
	return match ? PRIORITY_RANK[match[1]] : null;
}

const emptyParse = (): QuickAddParse => ({
	title: "",
	dueAt: null,
	dueAllDay: true,
	priority: 0,
	labels: [],
	listName: null,
	tokens: [],
});

export function normalizeListName(value: string): string {
	return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** A chip the user turned back into plain words, located by its span in the input. */
export type KeptSpan = { start: number; end: number; text: string };

// Stands in for a kept span while parsing. A private-use code point is neither
// space, word, sigil nor digit, so no pass can read or cross it.
const KEPT = "\uE000";

/**
 * Carries kept spans across an edit from `prev` to `next`. Only the changed
 * middle is unknown: a span before it stays, one after it shifts, one touching
 * it is dropped. Survivors must still spell the same characters.
 */
export function shiftKeptSpans(
	prev: string,
	next: string,
	spans: readonly KeptSpan[],
): KeptSpan[] {
	const max = Math.min(prev.length, next.length);
	let head = 0;
	while (head < max && prev[head] === next[head]) head++;
	let tail = 0;
	while (
		tail < max - head &&
		prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
	)
		tail++;
	const delta = next.length - prev.length;
	const out: KeptSpan[] = [];
	for (const span of spans) {
		const moved =
			span.end <= head
				? span
				: span.start >= prev.length - tail
					? { ...span, start: span.start + delta, end: span.end + delta }
					: null;
		if (moved && next.slice(moved.start, moved.end) === moved.text)
			out.push(moved);
	}
	return out;
}

/**
 * `kept` lists spans the caller wants left in the title untouched, for a chip
 * the user turned back into plain words. A span whose characters no longer
 * match the input is ignored.
 */
export function parseQuickAdd(
	input: string,
	now: Date = new Date(),
	locale = "en",
	listNames?: readonly string[],
	kept: readonly KeptSpan[] = [],
): QuickAddParse {
	// Task 10 feeds an onChange value; guard the never-throws contract.
	if (typeof input !== "string") return emptyParse();
	const chars = input.split("");
	const keptRanges: [number, number][] = [];
	for (const span of kept) {
		if (input.slice(span.start, span.end) !== span.text) continue;
		keptRanges.push([span.start, span.end]);
		for (let i = span.start; i < span.end; i++) chars[i] = KEPT;
	}
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

	// A destination starts at a word boundary; punctuation and URLs remain prose.
	const listStarts = [
		...chars.join("").matchAll(/(?:^|(?<=\s))~(?=[\p{L}\p{N}_-])/gu),
	];
	for (const match of listStarts) {
		const start = match.index;
		const rest = chars.join("").slice(start + 1);
		let length = 0;
		if (listNames) {
			for (let end = 1; end <= rest.length; end++) {
				if (end < rest.length && !/[\s#~.,!?;:]/u.test(rest[end])) continue;
				const candidate = normalizeListName(rest.slice(0, end));
				if (listNames.some((name) => normalizeListName(name) === candidate))
					length = end;
			}
		}
		if (!length) length = /^[\p{L}\p{M}\p{N}_-]+/u.exec(rest)?.[0].length ?? 0;
		const end = start + 1 + length;
		if (listName === null) listName = input.slice(start + 1, end);
		tokens.push({ type: "list", text: input.slice(start, end), start, end });
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
	const scanned = chars.join("");
	// A match glued to a word ("55ccea73-813d-406e", "v2-3d") is not a date.
	const glued = (c: string | undefined) => !!c && /[\p{L}\p{N}_-]/u.test(c);
	const dateResults = (
		parser ? parser.parse(scanned, now, { forwardDate: true }) : []
	).filter(
		(r) =>
			!glued(scanned[r.index - 1]) && !glued(scanned[r.index + r.text.length]),
	);
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

	for (const [start, end] of keptRanges)
		for (let i = start; i < end; i++) chars[i] = input[i];
	const title = chars.join("").split(/\s+/).filter(Boolean).join(" ");

	// Task 10's TokenChips walks tokens left-to-right; return sorted by span start.
	tokens.sort((a, b) => a.start - b.start);

	return { title, dueAt, dueAllDay, priority, labels, listName, tokens };
}

export type LeadingAmount = {
	quantity: string;
	unit: string;
	title: string;
	token: QuickAddToken;
};

// Units short enough to be unmistakable after a number. Anything else after the
// number is part of the item's name: "2 oat milk" is two "oat milk".
const AMOUNT_RE =
	/^(\s*)(\d{1,6}(?:[.,]\d{1,3})?)(?:\s*(kg|mg|g|ml|cl|dl|l|oz|lbs|lb|pcs|pc)\b|\s*x\b)?\s+(?=\S)/iu;

/**
 * A leading amount on a shopping item ("2 milk", "500 g flour", "2x eggs").
 * The number must be followed by whitespace, so "7up" and "2%" stay names.
 */
export function parseLeadingAmount(input: string): LeadingAmount | null {
	if (typeof input !== "string") return null;
	const match = AMOUNT_RE.exec(input);
	if (!match) return null;
	const quantity = match[2];
	const unit = match[3] ?? "";
	if (!isValidQuantity(quantity) || !isValidUnit(unit)) return null;
	const start = match[1].length;
	const end = match[0].trimEnd().length;
	return {
		quantity,
		unit,
		title: input.slice(match[0].length).split(/\s+/).filter(Boolean).join(" "),
		token: { type: "quantity", text: input.slice(start, end), start, end },
	};
}
