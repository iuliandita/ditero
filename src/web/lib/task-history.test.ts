import { afterEach, expect, test, vi } from "vitest";
import {
	loadTaskHistory,
	TaskHistoryTransportError,
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
test("a fetch network rejection is distinct from authoritative and invalid data failures", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
	);
	await expect(
		loadTaskHistory("task", "space", null, new AbortController().signal),
	).rejects.toBeInstanceOf(TaskHistoryTransportError);
});
test("an aborted fetch rejection cannot retain transport cache", async () => {
	const error = new TypeError("Failed to fetch"),
		controller = new AbortController();
	controller.abort();
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
	await expect(
		loadTaskHistory("task", "space", null, controller.signal),
	).rejects.toBe(error);
});
test("AbortError and unexpected fetch exceptions remain fail-loud", async () => {
	const errors = [
		new DOMException("Aborted", "AbortError"),
		new Error("Unexpected fetch failure"),
	];
	for (const error of errors) {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
		await expect(
			loadTaskHistory("task", "space", null, new AbortController().signal),
		).rejects.toBe(error);
	}
});
test("a response-body TypeError is not treated as a fetch transport rejection", async () => {
	const error = new TypeError("Invalid response body");
	vi.stubGlobal(
		"fetch",
		vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockRejectedValue(error),
		}),
	);
	await expect(
		loadTaskHistory("task", "space", null, new AbortController().signal),
	).rejects.toBe(error);
});
