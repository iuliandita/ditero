import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { calendarFeedCreatedSchema } from "../../../domain/public-api-calendar-feed.ts";
import {
	type CalendarFeedMetadata,
	CalendarFeedRows,
	CalendarFeedsPanel,
	calendarFeedUrl,
	feedErrorMessage,
	feedStatus,
	requestCalendarFeeds,
} from "./CalendarFeedsPanel.tsx";

vi.mock("../../lib/auth-client.ts", () => ({
	authClient: { useSession: () => ({ data: null }) },
}));
vi.mock("../../../paraglide/runtime.js", () => ({
	getLocale: () => "en",
	experimentalStaticLocale: undefined,
}));
afterEach(() => vi.unstubAllGlobals());
const feed: CalendarFeedMetadata = {
	id: "b27f2ae3-62e3-411f-8d38-02ad94d07f12",
	name: "Household calendar",
	hint: "abcd",
	listId: "list-a",
	workspaceId: "workspace-a",
	createdAt: "2026-01-01T00:00:00.000Z",
	expiresAt: "2026-06-01T00:00:00.000Z",
	revokedAt: null,
};
const secret = `ditero_feed_${"a".repeat(43)}`;
const created = {
	...feed,
	secret,
	path: `/api/v1/calendar-feeds/${secret}/calendar.ics`,
};
const selection = { id: feed.listId, workspaceId: feed.workspaceId };

describe("calendar metadata and capability binding", () => {
	test("expiry takes effect at its exact boundary and revocation wins", () => {
		const now = Date.parse(feed.expiresAt);
		expect(feedStatus(feed, now - 1)).toBe("active");
		expect(feedStatus(feed, now)).toBe("expired");
		expect(feedStatus({ ...feed, revokedAt: feed.createdAt }, now - 1)).toBe(
			"revoked",
		);
	});
	test("builds a URL only for the captured original list and workspace", () => {
		expect(
			calendarFeedUrl(created, selection, "https://calendar.example.test"),
		).toBe(`https://calendar.example.test${created.path}`);
		for (const result of [
			{ ...created, listId: "another" },
			{ ...created, workspaceId: "another" },
			{
				...created,
				path: created.path.replace(secret, `ditero_feed_${"b".repeat(43)}`),
			},
		])
			expect(() =>
				calendarFeedUrl(result, selection, "https://calendar.example.test"),
			).toThrow("scope mismatch");
	});
	test("metadata keeps unavailable original scopes revocable and never renders a secret", () => {
		const markup = renderToStaticMarkup(
			<CalendarFeedRows
				feeds={[{ ...feed, name: "<script>calendar</script>" }]}
				lists={[]}
				workspaces={[]}
				now={Date.parse(feed.createdAt)}
				busy={false}
				onRevoke={() => {}}
			/>,
		);
		expect(markup).toContain("List unavailable");
		expect(markup).toContain("Active");
		expect(markup).toContain("…abcd");
		expect(markup).toContain("&lt;script&gt;calendar&lt;/script&gt;");
		expect(markup).not.toContain("ditero_feed_");
		expect(markup).toContain("Revoke");
	});
	test("visible scope names are escaped and pending actions disable revoke", () => {
		const markup = renderToStaticMarkup(
			<CalendarFeedRows
				feeds={[feed]}
				lists={[{ ...selection, title: "<List>" }]}
				workspaces={[{ id: feed.workspaceId, name: "Household" }]}
				now={Date.parse(feed.createdAt)}
				busy
				onRevoke={() => {}}
			/>,
		);
		expect(markup).toContain("&lt;List&gt;");
		expect(markup).toContain("Household");
		expect(markup).toContain('disabled=""');
	});
	test("a signed-out account never mounts synced queries or sends requests", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		expect(renderToStaticMarkup(<CalendarFeedsPanel />)).toContain(
			"Sign in again to manage calendar subscriptions.",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("calendar account requests", () => {
	test("forces current cookies, no caching and preserves cancellation", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(
				Response.json({ version: 1, data: created, nextCursor: null }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const controller = new AbortController();
		expect(
			await requestCalendarFeeds("", calendarFeedCreatedSchema, {
				method: "POST",
				credentials: "omit",
				cache: "force-cache",
				signal: controller.signal,
			}),
		).toEqual(created);
		expect(fetchMock).toHaveBeenCalledWith("/api/calendar-feeds", {
			method: "POST",
			credentials: "include",
			cache: "no-store",
			signal: controller.signal,
		});
	});
	test.each([
		{ version: 2, data: created, nextCursor: null },
		{ version: 1, data: { ...created, secret: "bad" }, nextCursor: null },
		{ version: 1, data: { ...created, extra: true }, nextCursor: null },
		{ version: 1, data: created, nextCursor: "cursor" },
		{ version: 1, data: created, nextCursor: null, extra: true },
	])("rejects malformed successful envelopes %#", async (body) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)));
		await expect(
			requestCalendarFeeds("", calendarFeedCreatedSchema, {}),
		).rejects.toBeInstanceOf(z.ZodError);
	});
	test("does not retry an uncertain POST or expose server details", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValue(new Error("private transport details"));
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			requestCalendarFeeds("", calendarFeedCreatedSchema, { method: "POST" }),
		).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			feedErrorMessage(new Error("private transport details")),
		).not.toContain("private transport");
	});
	test.each([
		[401, "unauthorized", "Sign in again"],
		[409, "feed-limit", "20 active"],
		[404, "not-found", "no longer available"],
		[429, "rate-limited", "server is busy"],
		[400, "invalid-feed-request", "Choose a list"],
	])("explains refusal %s", async (status, code, text) => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					Response.json(
						{ code, message: "private details" },
						{ status: Number(status) },
					),
				),
		);
		const failure = await requestCalendarFeeds("", z.unknown(), {}).catch(
			(error: unknown) => error,
		);
		expect(feedErrorMessage(failure)).toContain(String(text));
		expect(feedErrorMessage(failure)).not.toContain("private details");
	});
});
