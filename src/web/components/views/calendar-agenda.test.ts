import { describe, expect, it } from "vitest";
import { agendaDayKeys } from "./calendar-agenda.ts";

const days = [
	"2026-10-01",
	"2026-09-30",
	"2026-09-12",
	"2026-08-31",
	"2026-09-01",
];
describe("agendaDayKeys", () => {
	it("opens the current month at today and excludes grid spillover", () => {
		expect(agendaDayKeys(days, "2026-09-01", "2026-09-30", false)).toEqual([
			"2026-09-30",
		]);
	});
	it("retains earlier dates through the explicit inspection mode", () => {
		expect(agendaDayKeys(days, "2026-09-01", "2026-09-30", true)).toEqual([
			"2026-09-01",
			"2026-09-12",
			"2026-09-30",
		]);
	});
	it("shows a selected past or future month in full", () => {
		expect(agendaDayKeys(days, "2026-08-01", "2026-09-30", false)).toEqual([
			"2026-08-31",
		]);
		expect(agendaDayKeys(days, "2026-10-01", "2026-09-30", false)).toEqual([
			"2026-10-01",
		]);
	});
	it("keeps today's upcoming dates sorted and permits an empty agenda", () => {
		expect(agendaDayKeys(days, "2026-09-01", "2026-09-11", false)).toEqual([
			"2026-09-12",
			"2026-09-30",
		]);
		expect(agendaDayKeys(days, "2026-11-01", "2026-09-30", false)).toEqual([]);
	});
});
