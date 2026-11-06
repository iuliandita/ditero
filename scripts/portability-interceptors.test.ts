import type { APIResponse, Route } from "@playwright/test";
import { afterEach, expect, test, vi } from "vitest";
import { fetchPortabilityRead } from "../tests/e2e/portability-reads.ts";

const response = (status: number, headers = {}) =>
	({
		status: () => status,
		headers: () => headers,
		dispose: vi.fn(async () => {}),
	}) as unknown as APIResponse;
function route(method: string, fetch: ReturnType<typeof vi.fn>) {
	return {
		request: () => ({ method: () => method }),
		fetch,
	} as unknown as Route;
}
afterEach(() => vi.useRealTimers());

test("a held-response interceptor captures success after a busy read", async () => {
	vi.useFakeTimers();
	const busy = response(429, { "retry-after": "1" });
	const success = response(200);
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(busy)
		.mockResolvedValueOnce(success);
	const result = fetchPortabilityRead(route("GET", fetch));
	await vi.advanceTimersByTimeAsync(999);
	expect(fetch).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(await result).toBe(success);
	expect(busy.dispose).toHaveBeenCalledOnce();
	expect(fetch.mock.calls).toEqual([
		[{ timeout: 15_000, maxRetries: 0 }],
		[{ timeout: 14_000, maxRetries: 0 }],
	]);
});

test.each([
	429, 503,
])("persistent status %s remains visible after the read budget", async (status) => {
	vi.useFakeTimers();
	const fetch = vi.fn(async () => response(status));
	const result = fetchPortabilityRead(route("GET", fetch));
	await vi.advanceTimersByTimeAsync(1000);
	expect((await result).status()).toBe(status);
	expect(fetch).toHaveBeenCalledTimes(status === 429 ? 3 : 1);
});

test("a busy response cannot extend the total read deadline", async () => {
	vi.useFakeTimers();
	const fetch = vi.fn(async () => {
		vi.setSystemTime(Date.now() + 12_000);
		return response(429, { "retry-after": "5" });
	});
	expect((await fetchPortabilityRead(route("GET", fetch))).status()).toBe(429);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});

test.each([
	"POST",
	"DELETE",
])("%s never enters the read retry helper", async (method) => {
	const fetch = vi.fn();
	await expect(fetchPortabilityRead(route(method, fetch))).rejects.toThrow();
	expect(fetch).not.toHaveBeenCalled();
});
