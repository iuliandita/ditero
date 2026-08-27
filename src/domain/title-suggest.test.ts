import { describe, expect, test } from "vitest";
import {
	MIN_QUERY_LENGTH,
	suggestTitles,
	type TitleCandidate,
} from "./title-suggest.ts";

const c = (title: string, listId = "L1"): TitleCandidate => ({ title, listId });

describe("suggestTitles", () => {
	test("a query shorter than the minimum suggests nothing", () => {
		const rows = [c("Milk"), c("Muesli")];
		expect(suggestTitles("m", rows, { listId: "L1" })).toEqual([]);
		expect("m".length).toBeLessThan(MIN_QUERY_LENGTH);
		// Paired presence assertion: the same rows DO match at the minimum, so
		// the empty result above is the length rule and not an unmatchable query.
		expect(suggestTitles("mi", rows, { listId: "L1" })).toEqual(["Milk"]);
	});

	test("matches mid-word but ranks prefix matches first", () => {
		// "mil", not "milk": an exact query would drop "Milk" under the rule
		// below, which is the same list this assertion is trying to order.
		const rows = [c("Almond milk"), c("Milk")];
		expect(suggestTitles("mil", rows, { listId: "L1" })).toEqual([
			"Milk",
			"Almond milk",
		]);
	});

	test("the current list outranks other lists even for a mid-word match", () => {
		const rows = [c("Bread", "other"), c("Wholemeal bread", "L1")];
		// "Bread" is the PREFIX match here and still loses, which is the point:
		// list proximity outranks match position.
		expect(suggestTitles("brea", rows, { listId: "L1" })).toEqual([
			"Wholemeal bread",
			"Bread",
		]);
	});

	test("an exact match is dropped: there is nothing left to complete", () => {
		const rows = [c("Milk"), c("Milk chocolate")];
		expect(suggestTitles("milk", rows, { listId: "L1" })).toEqual([
			"Milk chocolate",
		]);
	});

	test("case and surrounding whitespace do not create duplicates", () => {
		const rows = [c("Milk"), c("  milk  "), c("MILK"), c("Milk tea")];
		expect(suggestTitles("mil", rows, { listId: "L1" })).toEqual([
			"Milk",
			"Milk tea",
		]);
	});

	test("respects the limit and stays deterministic on ties", () => {
		const many = [c("box a"), c("box c"), c("box b")];
		// Equal rank and equal length, so the tie-break is alphabetical -- and
		// the limit drops "box c" rather than returning input order.
		expect(suggestTitles("box", many, { listId: "L1", limit: 2 })).toEqual([
			"box a",
			"box b",
		]);
		expect(suggestTitles("box", many, { listId: "L1" })).toEqual([
			"box a",
			"box b",
			"box c",
		]);
	});

	test("blank titles never surface as empty rows", () => {
		expect(
			suggestTitles("mi", [c("   "), c("Milk")], { listId: "L1" }),
		).toEqual(["Milk"]);
	});
});
