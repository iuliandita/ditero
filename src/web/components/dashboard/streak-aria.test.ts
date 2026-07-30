import { describe, expect, test } from "vitest";
import { m } from "../../../paraglide/messages.js";

// The streak row's aria-label used to be assembled as "{title}: {summary}."
// from a second translated message, which no translator could reorder across.
// Expected values here are catalog literals, not `m.*()`, so an emptied entry
// fails the assertion instead of matching itself.

describe("panel_streak_row_aria", () => {
	test("carries the whole sentence, with no fragment seam left", () => {
		const label = m.panel_streak_row_aria(
			{ title: "Walk the dog", count: 5, pct: 80 },
			{ locale: "en" },
		);
		expect(label).toBe("Walk the dog: 5 day streak, 80% on track. Open task");
		expect(label).not.toContain("{");
		expect(label).not.toContain("undefined");
	});

	test("still inflects on count now that the plural lives in the label", () => {
		const one = m.panel_streak_row_aria(
			{ title: "Meds", count: 1, pct: 100 },
			{ locale: "de" },
		);
		const many = m.panel_streak_row_aria(
			{ title: "Meds", count: 3, pct: 100 },
			{ locale: "de" },
		);
		expect(one).toBe("Meds: 1 Tag Serie, 100% im Plan. Aufgabe öffnen");
		expect(many).toBe("Meds: 3 Tage Serie, 100% im Plan. Aufgabe öffnen");
	});

	// Arabic distinguishes six categories; merging the fragment into the label
	// had to carry all of them across rather than collapse to one/other.
	test("keeps the full Arabic category set", () => {
		const two = m.panel_streak_row_aria(
			{ title: "المشي", count: 2, pct: 50 },
			{ locale: "ar" },
		);
		const few = m.panel_streak_row_aria(
			{ title: "المشي", count: 3, pct: 50 },
			{ locale: "ar" },
		);
		expect(two).toContain("يومين");
		expect(few).toContain("أيام");
		expect(two).not.toBe(few);
	});
});

describe("panel_streak_no_recurrence_row_aria", () => {
	test("is its own whole message, not the streak label with a hole", () => {
		expect(
			m.panel_streak_no_recurrence_row_aria(
				{ title: "Stretch" },
				{ locale: "en" },
			),
		).toBe("Stretch: no recurrence set. Open task");
	});

	// French spaces its colon; the old composed label did too, and merging the
	// sentence must not quietly drop that.
	test("preserves the French spaced colon", () => {
		expect(
			m.panel_streak_no_recurrence_row_aria(
				{ title: "Étirements" },
				{ locale: "fr" },
			),
		).toBe("Étirements : aucune répétition définie. Ouvrir la tâche");
	});
});
