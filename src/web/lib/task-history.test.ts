import { afterEach, expect, test, vi } from "vitest";
import {
	loadTaskHistory,
	TaskHistoryUnavailableError,
} from "./task-history.ts";

afterEach(() => vi.unstubAllGlobals());
test("history requests bind both parents, preserve the total cursor, and avoid cached credentials or data", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValue(Response.json({ rows: [], nextCursor: null }));
	vi.stubGlobal("fetch", fetcher);
	const controller = new AbortController();
	const cursor = { recordedAt: 0, sourceKind: "imported" as const, id: "hash" };
	expect(await loadTaskHistory("", "space", cursor, controller.signal)).toEqual(
		{ rows: [], nextCursor: null },
	);
	const [url, options] = fetcher.mock.calls[0] ?? [];
	const parameters = new URL(url, "http://localhost").searchParams;
	expect(parameters.get("taskId")).toBe("");
	expect(parameters.get("workspaceId")).toBe("space");
	expect(JSON.parse(parameters.get("cursor") ?? "")).toEqual(cursor);
	expect(options).toMatchObject({
		credentials: "same-origin",
		cache: "no-store",
		signal: controller.signal,
	});
});
test.each([
	401, 403, 404,
])("access refusal %s clears availability rather than trusting a response body", async (status) => {
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValue(
				Response.json({ rows: [], nextCursor: null }, { status }),
			),
	);
	await expect(
		loadTaskHistory("task", "space", null, new AbortController().signal),
	).rejects.toBeInstanceOf(TaskHistoryUnavailableError);
});
test("failed and incomplete pages cannot be accepted as complete history", async () => {
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(new Response("", { status: 503 }))
		.mockResolvedValueOnce(Response.json({ rows: [] }));
	vi.stubGlobal("fetch", fetcher);
	await expect(
		loadTaskHistory("task", "space", null, new AbortController().signal),
	).rejects.toThrow();
	await expect(
		loadTaskHistory("task", "space", null, new AbortController().signal),
	).rejects.toThrow();
});
