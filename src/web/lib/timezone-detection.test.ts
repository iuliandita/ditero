import { describe, expect, it } from "vitest";
import { timeZoneToDetect } from "./timezone-detection.ts";

describe("timeZoneToDetect", () => {
	it("replaces the unchosen UTC default with the browser zone", () => {
		expect(
			timeZoneToDetect(
				{ timezone: "UTC", timezoneChosen: false },
				"Europe/Berlin",
			),
		).toBe("Europe/Berlin");
	});

	it("keeps a UTC the user picked on purpose", () => {
		expect(
			timeZoneToDetect(
				{ timezone: "UTC", timezoneChosen: true },
				"Europe/Berlin",
			),
		).toBeNull();
	});

	it("never overwrites a real zone, chosen or not", () => {
		expect(
			timeZoneToDetect(
				{ timezone: "Asia/Tokyo", timezoneChosen: false },
				"Europe/Berlin",
			),
		).toBeNull();
	});

	it("writes nothing when the browser has no usable zone", () => {
		const stored = { timezone: "UTC", timezoneChosen: false };
		expect(timeZoneToDetect(stored, null)).toBeNull();
		expect(timeZoneToDetect(stored, "UTC")).toBeNull();
	});
});
