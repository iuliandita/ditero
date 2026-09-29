import { describe, expect, it } from "vitest";
import {
	cldrFirstDay,
	dayKey,
	firstWeekday,
	formatTimeValue,
	monthCells,
	nextWeekStart,
	parseDayKey,
	parseDueText,
	parseTimeText,
	weekdayNames,
} from "./date-picker.ts";

const hasWeekInfo = (() => {
	const loc = new Intl.Locale("en-US") as Intl.Locale & {
		getWeekInfo?: unknown;
		weekInfo?: unknown;
	};
	return loc.getWeekInfo !== undefined || loc.weekInfo !== undefined;
})();

describe("firstWeekday", () => {
	it.skipIf(!hasWeekInfo)("follows the region the locale implies", () => {
		expect(firstWeekday("en")).toBe(0);
		expect(firstWeekday("de")).toBe(1);
		expect(firstWeekday("ar")).toBe(6);
	});

	it.skipIf(!hasWeekInfo)(
		"prefers a browser tag with a region for the same language",
		() => {
			expect(firstWeekday("en", ["en-GB", "de-DE"])).toBe(1);
			// A different language's region is not evidence about this one.
			expect(firstWeekday("en", ["de-DE"])).toBe(0);
		},
	);
});

describe("firstWeekday without Intl week info", () => {
	const none = () => null;
	it("falls back to CLDR for the app locales", () => {
		expect(firstWeekday("en", [], none)).toBe(0);
		expect(firstWeekday("ar", [], none)).toBe(6);
		for (const locale of ["de", "es", "fr", "ro"])
			expect(firstWeekday(locale, [], none)).toBe(1);
	});
	it("uses the browser's region for the same language", () => {
		expect(firstWeekday("en", ["en-GB"], none)).toBe(1);
		expect(firstWeekday("ar", ["ar-SA"], none)).toBe(0);
		expect(firstWeekday("es", ["es-MX"], none)).toBe(0);
		expect(firstWeekday("en", ["de-DE"], none)).toBe(0);
	});
	it.skipIf(!hasWeekInfo)("agrees with Intl week info", () => {
		for (const tag of ["en", "en-GB", "ar", "ar-SA", "de", "es-MX", "fr", "ro"])
			expect(cldrFirstDay(tag), tag).toBe(firstWeekday(tag));
	});
});

describe("monthCells", () => {
	it("pads September 2026 to whole weeks from the first weekday", () => {
		// 2026-09-01 is a Tuesday.
		const monday = monthCells(2026, 8, 1);
		expect(monday.slice(0, 2)).toEqual([null, expect.any(Date)]);
		expect(monday[1]?.getDate()).toBe(1);
		expect(monday.length % 7).toBe(0);
		const sunday = monthCells(2026, 8, 0);
		expect(sunday.slice(0, 2)).toEqual([null, null]);
		expect(sunday[2]?.getDate()).toBe(1);
		expect(sunday.filter(Boolean)).toHaveLength(30);
	});
});

describe("weekdayNames", () => {
	it("starts at the requested day", () => {
		expect(weekdayNames("en", 1)[0].long).toBe("Monday");
		expect(weekdayNames("en", 0)[0].long).toBe("Sunday");
		expect(weekdayNames("en", 6)[6].long).toBe("Friday");
	});
});

describe("nextWeekStart", () => {
	it("lands on the first day of the following week", () => {
		const wed = new Date(2026, 8, 30);
		expect(dayKey(nextWeekStart(wed, 1))).toBe("2026-10-05");
		expect(dayKey(nextWeekStart(wed, 0))).toBe("2026-10-04");
		// On the first day itself, a whole week ahead.
		expect(dayKey(nextWeekStart(new Date(2026, 9, 5), 1))).toBe("2026-10-12");
	});
});

describe("parseDayKey", () => {
	it("rejects days that roll over", () => {
		expect(parseDayKey("2026-02-31")).toBeNull();
		expect(parseDayKey("2026-02-28")?.getDate()).toBe(28);
	});
});

describe("parseDueText", () => {
	const now = new Date(2026, 8, 28, 10, 0);
	it("reads ISO keys as all-day", () => {
		expect(parseDueText("2026-10-02", "en", now)).toEqual({
			date: "2026-10-02",
			time: null,
		});
	});
	it("reads the quick-add grammar, with and without a time", () => {
		expect(parseDueText("tomorrow", "en", now)).toEqual({
			date: "2026-09-29",
			time: null,
		});
		expect(parseDueText("tomorrow 5pm", "en", now)).toEqual({
			date: "2026-09-29",
			time: "17:00",
		});
	});
	it("rejects impossible ISO days instead of guessing", () => {
		expect(parseDueText("2026-13-01", "en", now)).toBeNull();
		expect(parseDueText("2026-02-31", "en", now)).toBeNull();
	});
	it("accepts unpadded ISO days", () => {
		expect(parseDueText("2026-2-3", "en", now)).toEqual({
			date: "2026-02-03",
			time: null,
		});
	});
	it("returns null for text that names no date", () => {
		expect(parseDueText("whenever", "en", now)).toBeNull();
		expect(parseDueText("  ", "en", now)).toBeNull();
	});
});

describe("parseTimeText", () => {
	it.each([
		["17:30", "17:30"],
		["5:30 pm", "17:30"],
		["5pm", "17:00"],
		["12am", "00:00"],
		["12 PM", "12:00"],
		["1730", "17:30"],
		["830", "08:30"],
		["8.15", "08:15"],
		["8", "08:00"],
		["٠٨:٣٠", "08:30"],
	])("%s -> %s", (input, expected) => {
		expect(parseTimeText(input, "en")).toBe(expected);
	});

	it.each(["", "25:00", "13pm", "8:75", "noonish"])("rejects %j", (input) => {
		expect(parseTimeText(input, "en")).toBeNull();
	});

	it("round-trips its own display form in every app locale", () => {
		for (const locale of ["en", "de", "es", "fr", "ro", "ar"]) {
			for (const value of ["00:05", "08:30", "12:00", "17:45", "23:59"]) {
				expect(parseTimeText(formatTimeValue(value, locale), locale)).toBe(
					value,
				);
			}
		}
	});
});
