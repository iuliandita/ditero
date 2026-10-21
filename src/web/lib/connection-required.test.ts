import { afterEach, expect, test, vi } from "vitest";
import {
	ConnectionRequiredError,
	connectionRetry,
	fetchWithConnectionCheck,
	isConnectionFailure,
} from "./connection-required.ts";
import { browserZeroRuntime } from "./zero-runtime.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const operations = [
	[
		"session transport",
		() => fetchWithConnectionCheck("/api/auth/get-session"),
	],
	["bootstrap", () => browserZeroRuntime.bootstrap()],
	["config", () => browserZeroRuntime.fetchConfig()],
	["token", () => browserZeroRuntime.getAuth()],
] as const;

test.each(
	operations,
)("%s requires a connection only for transport failure", async (_name, run) => {
	const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
	vi.stubGlobal("fetch", fetch);
	vi.stubGlobal("navigator", { onLine: true });
	await expect(run()).rejects.toBeInstanceOf(ConnectionRequiredError);
	for (const status of [401, 403, 500, 503]) {
		// An offline event after the response must not rewrite HTTP semantics.
		vi.stubGlobal("navigator", { onLine: false });
		const response = new Response(null, { status });
		fetch.mockResolvedValue(response);
		try {
			await run();
		} catch (error) {
			expect(isConnectionFailure(error)).toBe(false);
		}
	}
});

test("session decisions preserve HTTP errors and response parsing errors even when offline", () => {
	vi.stubGlobal("navigator", { onLine: false });
	for (const status of [401, 403, 500, 503])
		expect(isConnectionFailure({ status, message: "refused" })).toBe(false);
	expect(isConnectionFailure(new SyntaxError("bad response"))).toBe(false);
	expect(isConnectionFailure(new TypeError("bad response"))).toBe(false);
	expect(isConnectionFailure(null)).toBe(false);
	expect(isConnectionFailure({ status: 0 })).toBe(true);
	expect(isConnectionFailure(new ConnectionRequiredError())).toBe(true);
});

test("retries online and manually, coalesces pending attempts, caps backoff and stops on disposal", async () => {
	vi.useFakeTimers();
	const signals = new EventTarget();
	const attempt = vi.fn(async () => {});
	const owner = connectionRetry(attempt, signals);
	let count = 0;
	for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
		await vi.advanceTimersByTimeAsync(delay - 1);
		expect(attempt).toHaveBeenCalledTimes(count);
		await vi.advanceTimersByTimeAsync(1);
		expect(attempt).toHaveBeenCalledTimes(++count);
	}
	let release!: () => void;
	attempt.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	signals.dispatchEvent(new Event("online"));
	signals.dispatchEvent(new Event("online"));
	await owner.retry();
	expect(attempt).toHaveBeenCalledTimes(++count);
	owner.stop();
	release();
	await vi.advanceTimersByTimeAsync(120_000);
	signals.dispatchEvent(new Event("online"));
	await owner.retry();
	expect(attempt).toHaveBeenCalledTimes(count);
	expect(vi.getTimerCount()).toBe(0);
});
