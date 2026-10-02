import { describe, expect, it } from "vitest";
import { parseRegistration } from "./contracts.ts";
import {
	parseDesktopEnrollment,
	parseDesktopPoll,
	parseDesktopRegistration,
} from "./desktop-contracts.ts";

describe("desktop push contracts", () => {
	it("accepts only empty enrollment and the exact encrypted desktop configuration", () => {
		expect(parseDesktopEnrollment({})).toEqual({ provider: "desktop" });
		expect(parseDesktopRegistration({ provider: "desktop" })).toEqual({
			provider: "desktop",
		});
		expect(parseRegistration({ provider: "desktop" })).toBeNull();
		for (const input of [
			{ provider: "desktop" },
			{ endpoint: "https://example.test" },
			{ userId: "u" },
		])
			expect(parseDesktopEnrollment(input)).toBeNull();
		for (const input of [
			{},
			{ provider: "fcm" },
			{ provider: "desktop", endpoint: "https://example.test" },
			Object.create({ provider: "desktop" }),
		])
			expect(parseDesktopRegistration(input)).toBeNull();
	});
	it("accepts an opaque registration ID and refuses caller authority and malformed IDs", () => {
		expect(parseDesktopPoll({ registrationId: "reg-1.a:b_c" })).toEqual({
			registrationId: "reg-1.a:b_c",
		});
		for (const input of [
			{},
			{ registrationId: "" },
			{ registrationId: "r".repeat(129) },
			{ registrationId: "r/r" },
			{ registrationId: 1 },
			{ registrationId: "r", userId: "u" },
			Object.create({ registrationId: "r" }),
		])
			expect(parseDesktopPoll(input)).toBeNull();
	});
});
