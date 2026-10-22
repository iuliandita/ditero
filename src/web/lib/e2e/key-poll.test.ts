import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startKeyPoll } from "./key-poll.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("runs on the interval until a run reports done", async () => {
	const run = vi
		.fn<() => Promise<boolean | undefined>>()
		.mockResolvedValueOnce(undefined)
		.mockResolvedValueOnce(true);
	startKeyPoll({ intervalMs: 1_000, run, onError: vi.fn() });
	await vi.advanceTimersByTimeAsync(999);
	expect(run).toHaveBeenCalledTimes(0);
	await vi.advanceTimersByTimeAsync(1);
	expect(run).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(5_000);
	expect(run).toHaveBeenCalledTimes(2);
});

it("never overlaps a slow run with the next one", async () => {
	let release = () => {};
	let active = 0;
	let peak = 0;
	const run = vi.fn(async () => {
		active += 1;
		peak = Math.max(peak, active);
		await new Promise<void>((resolve) => {
			release = resolve;
		});
		active -= 1;
	});
	startKeyPoll({ intervalMs: 1_000, run, onError: vi.fn() });
	await vi.advanceTimersByTimeAsync(10_000);
	expect(run).toHaveBeenCalledTimes(1);
	release();
	await vi.advanceTimersByTimeAsync(1_000);
	expect(run).toHaveBeenCalledTimes(2);
	expect(peak).toBe(1);
});

it("reports failures and backs off to the ceiling, resetting on success", async () => {
	const failure = new Error("pending grants failed (500)");
	const run = vi
		.fn<() => Promise<undefined>>()
		.mockRejectedValueOnce(failure)
		.mockRejectedValueOnce(failure)
		.mockRejectedValueOnce(failure)
		.mockResolvedValue(undefined);
	const onError = vi.fn();
	startKeyPoll({ intervalMs: 1_000, maxIntervalMs: 3_000, run, onError });
	await vi.advanceTimersByTimeAsync(1_000);
	expect(onError).toHaveBeenLastCalledWith(failure);
	await vi.advanceTimersByTimeAsync(1_999);
	expect(run).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(run).toHaveBeenCalledTimes(2);
	await vi.advanceTimersByTimeAsync(3_000);
	expect(run).toHaveBeenCalledTimes(3);
	expect(onError).toHaveBeenCalledTimes(3);
	await vi.advanceTimersByTimeAsync(3_000);
	expect(run).toHaveBeenCalledTimes(4);
	await vi.advanceTimersByTimeAsync(1_000);
	expect(run).toHaveBeenCalledTimes(5);
});

it("stops scheduling and swallows a late failure once stopped", async () => {
	let fail = (_error: Error) => {};
	const run = vi.fn(
		() =>
			new Promise<undefined>((_resolve, reject) => {
				fail = reject;
			}),
	);
	const onError = vi.fn();
	const poll = startKeyPoll({ intervalMs: 1_000, run, onError });
	await vi.advanceTimersByTimeAsync(1_000);
	poll.stop();
	fail(new Error("aborted"));
	await vi.advanceTimersByTimeAsync(10_000);
	expect(run).toHaveBeenCalledTimes(1);
	expect(onError).not.toHaveBeenCalled();
});

it("ends after the run budget", async () => {
	const run = vi.fn(async () => undefined);
	startKeyPoll({ intervalMs: 1_000, maxRuns: 3, run, onError: vi.fn() });
	await vi.advanceTimersByTimeAsync(60_000);
	expect(run).toHaveBeenCalledTimes(3);
});
