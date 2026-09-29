import { describe, expect, it } from "vitest";
import { timeZoneLabel, timeZoneOptions } from "./time-zones.ts";

describe("timeZoneOptions", () => {
	it("keeps the stored zone selectable when the runtime omits it", () => {
		const zones = timeZoneOptions("Mars/Olympus", () => ["Europe/Berlin"]);
		expect(zones).toEqual(["Europe/Berlin", "Mars/Olympus", "UTC"]);
	});

	it("falls back to the stored zone when listing throws", () => {
		const zones = timeZoneOptions("Europe/Berlin", () => {
			throw new Error("unsupported");
		});
		expect(zones).toEqual(["Europe/Berlin", "UTC"]);
	});

	it("does not duplicate a listed zone", () => {
		const zones = timeZoneOptions("Europe/Berlin", () => [
			"Europe/Berlin",
			"America/New_York",
		]);
		expect(zones.filter((z) => z === "Europe/Berlin")).toHaveLength(1);
	});
});

describe("timeZoneLabel", () => {
	it("shows underscores as spaces", () => {
		expect(timeZoneLabel("America/New_York")).toBe("America/New York");
	});
});
