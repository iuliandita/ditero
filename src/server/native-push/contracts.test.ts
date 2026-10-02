import { describe, expect, it } from "vitest";
import { parsePushOpen } from "./contracts.ts";

describe("native push open input", () => {
	it("accepts bounded ASCII capability identifiers without normalization", () => {
		const input = {
			notificationId: "outbox-1:retry_2.0",
			registrationId: "a".repeat(128),
		};
		expect(parsePushOpen(input)).toEqual(input);
	});
	it.each([
		{},
		{ notificationId: "n" },
		{ notificationId: "n", registrationId: "r", taskId: "t" },
		{ notificationId: "n", registrationId: "r", url: "https://example.test" },
		...["", "a".repeat(129), " n", "n/1", "café", "n\n", 1, null].map(
			(notificationId) => ({ notificationId, registrationId: "r" }),
		),
		...["", "a".repeat(129), "r/1", "r\n", "登録", false].map(
			(registrationId) => ({ notificationId: "n", registrationId }),
		),
	])("rejects invalid or caller-directed input %#", (input) => {
		expect(parsePushOpen(input)).toBeNull();
	});
});
