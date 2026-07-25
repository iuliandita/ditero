import { describe, expect, test } from "vitest";
import { levelProgress, reasonLabel, ringFraction } from "./karma-format.ts";

// Expected values are the English catalog literals, not `m.*()`: routing both
// sides through the same message makes the assertion pass even if the catalog
// entry is emptied. Locale coverage is locale-freeze.test.ts's job.

describe("reasonLabel", () => {
	test("maps known reasons", () => {
		expect(reasonLabel("task_complete")).toBe("Completed a task");
		expect(reasonLabel("habit_done")).toBe("Habit done");
		expect(reasonLabel("habit_undo")).toBe("Habit undone");
	});
	test("humanizes unknown reasons", () => {
		expect(reasonLabel("some_new_reason")).toBe("Some new reason");
		expect(reasonLabel("")).toBe("Karma change");
	});
	test("inherited Object keys never resolve as a label", () => {
		expect(reasonLabel("constructor")).toBe("Constructor");
		expect(reasonLabel("__proto__")).toBe("Proto");
	});
});

describe("ringFraction", () => {
	test("clamps and guards unset goal", () => {
		expect(ringFraction(3, 5)).toBeCloseTo(0.6);
		expect(ringFraction(9, 5)).toBe(1);
		expect(ringFraction(1, 0)).toBe(0); // unset goal, no divide-by-zero
		expect(ringFraction(-1, 5)).toBe(0);
	});
});

describe("levelProgress", () => {
	test("band-relative progress mid-level", () => {
		// LEVEL_THRESHOLDS[2]=150, [3]=300 -> level 3 band is 150..300.
		const p = levelProgress(220, 3);
		expect(p.maxed).toBe(false);
		expect(p.into).toBe(70);
		expect(p.span).toBe(150);
		expect(p.next).toBe(300);
		expect(p.fraction).toBeCloseTo(70 / 150);
	});
	test("maxed at top level", () => {
		const p = levelProgress(5000, 10);
		expect(p.maxed).toBe(true);
		expect(p.next).toBeNull();
		expect(p.fraction).toBe(1);
	});
});
