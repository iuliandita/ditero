import { describe, expect, it } from "vitest";
import { timeZoneLabel, timeZoneOptions } from "./time-zones.ts";

const ALIASES: Record<string, string> = {
	"Asia/Kolkata": "Asia/Calcutta",
	"Etc/UTC": "UTC",
};
const fakeResolve = (zone: string) => ALIASES[zone] ?? zone;

describe("timeZoneOptions", () => {
	it("keeps the stored zone selectable when the runtime omits it", () => {
		const { zones, selected } = timeZoneOptions(
			"Mars/Olympus",
			() => ["Europe/Berlin"],
			fakeResolve,
		);
		expect(zones).toEqual(["Europe/Berlin", "Mars/Olympus", "UTC"]);
		expect(selected).toBe("Mars/Olympus");
	});

	it("falls back to the stored zone when listing throws", () => {
		const { zones } = timeZoneOptions(
			"Europe/Berlin",
			() => {
				throw new Error("unsupported");
			},
			fakeResolve,
		);
		expect(zones).toEqual(["Europe/Berlin", "UTC"]);
	});

	it("maps a stored alias onto its listed equivalent, without a duplicate", () => {
		const { zones, selected } = timeZoneOptions(
			"Asia/Kolkata",
			() => ["Asia/Calcutta", "Europe/Berlin"],
			fakeResolve,
		);
		expect(zones).toEqual(["Asia/Calcutta", "Europe/Berlin", "UTC"]);
		expect(selected).toBe("Asia/Calcutta");
	});

	it("does not add UTC twice when the runtime lists an alias of it", () => {
		const { zones, selected } = timeZoneOptions(
			"UTC",
			() => ["Etc/UTC"],
			fakeResolve,
		);
		expect(zones).toEqual(["Etc/UTC"]);
		expect(selected).toBe("Etc/UTC");
	});

	it("folds aliases with the real engine too", () => {
		const { zones, selected } = timeZoneOptions("Asia/Kolkata");
		const india = zones.filter(
			(z) => z === "Asia/Kolkata" || z === "Asia/Calcutta",
		);
		expect(india).toHaveLength(1);
		expect(selected).toBe(india[0]);
	});
});

describe("timeZoneLabel", () => {
	it("shows underscores as spaces", () => {
		expect(timeZoneLabel("America/New_York")).toBe("America/New York");
	});
});
