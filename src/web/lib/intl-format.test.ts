import { afterEach, describe, expect, test, vi } from "vitest";
import * as runtime from "../../paraglide/runtime.js";
import { formatDayKey, formatList } from "./intl-format.ts";

function withLocale(locale: string) {
	vi.spyOn(runtime, "getLocale").mockReturnValue(
		locale as ReturnType<typeof runtime.getLocale>,
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("formatDayKey", () => {
	test("renders the day key in the active locale, not as raw ISO", () => {
		withLocale("en");
		const en = formatDayKey("2026-07-04");
		expect(en).not.toBe("2026-07-04");
		expect(en).toMatch(/4/);
	});

	test("a locale switch changes the output", () => {
		withLocale("en");
		const en = formatDayKey("2026-01-09", { dateStyle: "long" });
		withLocale("de");
		const de = formatDayKey("2026-01-09", { dateStyle: "long" });
		expect(de).not.toBe(en);
		expect(de).toContain("Januar");
	});

	// The day key is already the user's LOCAL day (domain/local-day.ts). Parsing
	// it as a Date would land on UTC midnight and render the 8th anywhere west
	// of UTC, silently disagreeing with the day the streak was logged against.
	test("does not shift the day west of UTC", () => {
		withLocale("en");
		const tz = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			expect(formatDayKey("2026-01-09", { day: "numeric" })).toBe("9");
		} finally {
			process.env.TZ = tz;
		}
	});

	test("a non-day-key string is returned untouched", () => {
		withLocale("en");
		expect(formatDayKey("not a date")).toBe("not a date");
		expect(formatDayKey("2026-7-4")).toBe("2026-7-4");
	});
});

describe("formatList", () => {
	// Arabic joins a conjunction list with "و" and no ASCII comma at all, so the
	// old `join(", ")` was not merely the wrong separator -- it was the wrong
	// construction. The Arabic comma appears in the "unit" type instead.
	test("uses the locale's own construction rather than a literal comma", () => {
		withLocale("ar");
		const names = ["أحمد", "سارة", "ليلى"];
		expect(formatList(names)).not.toContain(", ");
		expect(formatList(names)).toBe("أحمد وسارة وليلى");
		expect(formatList(names, "unit")).toContain("،");
	});

	test("a locale switch changes the conjunction", () => {
		withLocale("en");
		const en = formatList(["Ana", "Bo"]);
		withLocale("de");
		const de = formatList(["Ana", "Bo"]);
		expect(en).toContain("and");
		expect(de).toContain("und");
		expect(de).not.toBe(en);
	});

	test("single and empty lists degrade cleanly", () => {
		withLocale("en");
		expect(formatList(["Ana"])).toBe("Ana");
		expect(formatList([])).toBe("");
	});
});
