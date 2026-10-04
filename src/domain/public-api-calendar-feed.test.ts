import { describe, expect, it } from "vitest";
import {
	calendarFeedPath,
	parseCalendarFeedCreate,
	validCalendarFeedSecret,
} from "./public-api-calendar-feed.ts";

describe("calendar feed contract", () => {
	it("binds exactly one list with bounded lifetime", () => {
		expect(
			parseCalendarFeedCreate({ name: " Shared calendar ", listId: "list" }),
		).toEqual({ name: "Shared calendar", listId: "list", expiresInDays: 90 });
		for (const input of [
			{ name: "", listId: "list" },
			{ name: "bad\nname", listId: "list" },
			{ name: "\ud800", listId: "list" },
			{ name: "x", listId: "" },
			{ name: "x", listId: "list", workspaceId: "other" },
			{ name: "x", listId: "list", expiresInDays: 0 },
			{ name: "x", listId: "list", expiresInDays: 366 },
			{ name: "x", listId: "list", expiresInDays: "90" },
		])
			expect(() => parseCalendarFeedCreate(input)).toThrow();
	});
	it("uses a separate capability namespace and a fixed relative path", () => {
		const secret = `ditero_feed_${"a".repeat(43)}`;
		expect(validCalendarFeedSecret(secret)).toBe(true);
		expect(calendarFeedPath(secret)).toBe(
			`/api/v1/calendar-feeds/${secret}/calendar.ics`,
		);
		for (const invalid of [
			`${secret}x`,
			secret.slice(0, -1),
			secret.replace("feed", "pat"),
			`${secret}?listId=x`,
			secret.replace("a", "/"),
		])
			expect(validCalendarFeedSecret(invalid)).toBe(false);
	});
});
