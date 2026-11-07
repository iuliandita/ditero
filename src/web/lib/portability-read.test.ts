import { afterEach, expect, test, vi } from "vitest";
import { readPortabilityMetadata } from "./portability-read.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test.each([
	"/api/portability/import/sources",
	"/api/portability/import/plans/id/run",
])("%s retries busy reads with the same credentials and respects Retry-After", async (path) => {
	vi.useFakeTimers();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(null, { status: 429, headers: { "Retry-After": "1" } }),
		)
		.mockResolvedValueOnce(Response.json({ run: null }));
	vi.stubGlobal("fetch", fetch);
	const result = readPortabilityMetadata(path, new AbortController().signal);
	await vi.advanceTimersByTimeAsync(999);
	expect(fetch).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(await result).toEqual({ run: null });
	expect(fetch).toHaveBeenCalledTimes(2);
	for (const call of fetch.mock.calls)
		expect(call).toEqual([
			path,
			{
				signal: expect.any(AbortSignal),
				credentials: "same-origin",
				cache: "no-store",
			},
		]);
});

test.each([
	401, 403, 409, 500, 429,
])("status %s remains an explicit failure after its retry budget", async (status) => {
	vi.useFakeTimers();
	const fetch = vi.fn(async () => new Response(null, { status }));
	vi.stubGlobal("fetch", fetch);
	const result = readPortabilityMetadata(
		"/status",
		new AbortController().signal,
	);
	const rejection = expect(result).rejects.toThrow(
		"Import metadata unavailable",
	);
	await vi.advanceTimersByTimeAsync(1000);
	await rejection;
	expect(fetch).toHaveBeenCalledTimes(status === 429 ? 3 : 1);
});

test.each([
	"owner",
	"deadline",
])("%s cancellation ends a pending retry without a new request", async (cause) => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(new Response(null, { status: 429 }))
		.mockImplementation(
			(_path, options: RequestInit) =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason),
					);
				}),
		);
	vi.stubGlobal("fetch", fetch);
	const result = readPortabilityMetadata("/status", controller.signal);
	const rejection = expect(result).rejects.toMatchObject({
		name: "AbortError",
	});
	if (cause === "owner") {
		await vi.advanceTimersByTimeAsync(100);
		controller.abort();
	} else await vi.advanceTimersByTimeAsync(15_000);
	await rejection;
	expect(fetch).toHaveBeenCalledTimes(cause === "owner" ? 1 : 2);
	expect(vi.getTimerCount()).toBe(0);
});

test("panel cancellation also aborts reading a successful response body", async () => {
	const controller = new AbortController();
	let requested!: () => void;
	const reading = new Promise<void>((resolve) => {
		requested = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_path, options: RequestInit) => ({
			ok: true,
			status: 200,
			json: () =>
				new Promise((_resolve, reject) => {
					options.signal?.addEventListener("abort", () =>
						reject(options.signal?.reason),
					);
					requested();
				}),
		})),
	);
	const result = readPortabilityMetadata("/status", controller.signal);
	const rejection = expect(result).rejects.toMatchObject({
		name: "AbortError",
	});
	await reading;
	controller.abort();
	await rejection;
});
