import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	fetchZeroToken,
	SessionExpiredError,
	watchZeroAuth,
} from "./zero-auth.ts";

type State = { name: string };
function stateSource() {
	let listener: ((state: State) => void) | undefined;
	return {
		current: { name: "connected" },
		subscribe(fn: (state: State) => void) {
			listener = fn;
			return () => {
				listener = undefined;
			};
		},
		emit(state: State) {
			this.current = state;
			listener?.(state);
		},
	};
}
const stops: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});
const flush = () => vi.advanceTimersByTimeAsync(0);
function harness(getToken = vi.fn(async () => "fresh-token")) {
	const state = stateSource();
	const connect = vi.fn(async () => {
		state.emit({ name: "connecting" });
	});
	const rejected = vi.fn();
	const expired = vi.fn();
	const errors = vi.fn();
	let signal = () => {};
	const stopSignals = vi.fn();
	const stop = watchZeroAuth(
		{ connection: { state, connect } },
		getToken,
		errors,
		{
			onAuthRejected: rejected,
			onSessionExpired: expired,
			retrySignals: (fn) => {
				signal = fn;
				return stopSignals;
			},
		},
	);
	stops.push(stop);
	return {
		state,
		connect,
		getToken,
		rejected,
		expired,
		errors,
		signal: () => signal(),
		stop,
		stopSignals,
	};
}
describe("watchZeroAuth", () => {
	test("retries immediately, then follows the exact capped ladder without resetting on token success", async () => {
		const h = harness();
		h.state.emit({ name: "needs-auth" });
		await flush();
		expect(h.connect).toHaveBeenCalledWith({ auth: "fresh-token" });
		let count = 1;
		for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
			h.state.emit({ name: "needs-auth" });
			h.state.emit({ name: "needs-auth" });
			h.signal();
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(h.getToken).toHaveBeenCalledTimes(count);
			await vi.advanceTimersByTimeAsync(1);
			expect(h.getToken).toHaveBeenCalledTimes(++count);
		}
		expect(h.rejected).toHaveBeenCalledWith(true);
	});
	test("resets only on confirmed connected and clears the repeated rejection status", async () => {
		const h = harness();
		h.state.emit({ name: "needs-auth" });
		await flush();
		for (const delay of [1000, 2000]) {
			h.state.emit({ name: "needs-auth" });
			await vi.advanceTimersByTimeAsync(delay);
		}
		h.state.emit({ name: "needs-auth" });
		expect(h.rejected).toHaveBeenLastCalledWith(true);
		h.state.emit({ name: "connected" });
		expect(h.rejected).toHaveBeenLastCalledWith(false);
		h.state.emit({ name: "needs-auth" });
		await flush();
		expect(h.getToken).toHaveBeenCalledTimes(4);
		h.state.emit({ name: "needs-auth" });
		await vi.advanceTimersByTimeAsync(999);
		expect(h.getToken).toHaveBeenCalledTimes(4);
		await vi.advanceTimersByTimeAsync(1);
		expect(h.getToken).toHaveBeenCalledTimes(5);
	});
	test("coalesces pending refreshes and retains deadlines through connecting and explicit signals", async () => {
		let release!: (token: string) => void;
		const tokens = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const h = harness(tokens);
		h.state.emit({ name: "needs-auth" });
		h.signal();
		h.state.emit({ name: "needs-auth" });
		expect(tokens).toHaveBeenCalledTimes(1);
		release("token");
		await flush();
		h.state.emit({ name: "needs-auth" });
		h.signal();
		h.state.emit({ name: "connecting" });
		await vi.advanceTimersByTimeAsync(1500);
		expect(tokens).toHaveBeenCalledTimes(1);
		h.state.emit({ name: "needs-auth" });
		h.signal();
		expect(tokens).toHaveBeenCalledTimes(2);
	});
	test.each([
		401, 403,
	])("stops automatic refresh after endpoint %s but permits bounded explicit recovery", async (status) => {
		const tokens = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new SessionExpiredError(String(status)))
			.mockResolvedValue("restored");
		const h = harness(tokens);
		h.state.emit({ name: "needs-auth" });
		await flush();
		expect(h.expired).toHaveBeenLastCalledWith(true);
		h.signal();
		h.state.emit({ name: "needs-auth" });
		await vi.advanceTimersByTimeAsync(60000);
		expect(tokens).toHaveBeenCalledTimes(1);
		h.signal();
		h.signal();
		await flush();
		expect(tokens).toHaveBeenCalledTimes(2);
		expect(h.connect).toHaveBeenCalledWith({ auth: "restored" });
		expect(h.expired).toHaveBeenLastCalledWith(false);
		expect(h.rejected).not.toHaveBeenCalledWith(true);
	});
	test("network and token endpoint failures never count as proven server auth rejection", async () => {
		const h = harness(
			vi.fn(async () => {
				throw new Error("offline");
			}),
		);
		h.state.emit({ name: "needs-auth" });
		await flush();
		for (const delay of [1000, 2000, 4000])
			await vi.advanceTimersByTimeAsync(delay);
		expect(h.getToken).toHaveBeenCalledTimes(4);
		expect(h.rejected).not.toHaveBeenCalledWith(true);
	});
	test("a resolved connect with unchanged needs-auth does not prove rejection or start another attempt", async () => {
		const h = harness();
		h.connect.mockImplementation(async () => undefined);
		h.state.emit({ name: "needs-auth" });
		await flush();
		for (let i = 0; i < 4; i++) {
			h.state.emit({ name: "needs-auth" });
			h.signal();
		}
		await vi.advanceTimersByTimeAsync(60000);
		expect(h.getToken).toHaveBeenCalledTimes(1);
		expect(h.rejected).not.toHaveBeenCalledWith(true);
	});
	test("an explicit session check that is refused again stays bounded without a timer", async () => {
		const h = harness(
			vi.fn(async () => {
				throw new SessionExpiredError("401");
			}),
		);
		h.state.emit({ name: "needs-auth" });
		await flush();
		await vi.advanceTimersByTimeAsync(1000);
		h.signal();
		h.signal();
		await flush();
		h.signal();
		await vi.advanceTimersByTimeAsync(60000);
		expect(h.getToken).toHaveBeenCalledTimes(2);
		expect(h.rejected).not.toHaveBeenCalledWith(true);
	});
	test("a new needs-auth transition after connected waits for the stale pending request to settle", async () => {
		let reject!: (error: Error) => void;
		const tokens = vi
			.fn<() => Promise<string>>()
			.mockImplementationOnce(
				() =>
					new Promise((_, no) => {
						reject = no;
					}),
			)
			.mockResolvedValue("new");
		const h = harness(tokens);
		h.state.emit({ name: "needs-auth" });
		h.state.emit({ name: "connected" });
		h.state.emit({ name: "needs-auth" });
		reject(new Error("stale"));
		await flush();
		expect(h.errors).not.toHaveBeenCalled();
		expect(tokens).toHaveBeenCalledTimes(2);
		expect(h.connect).toHaveBeenCalledWith({ auth: "new" });
	});
	test("ignores non-auth states", () => {
		const h = harness();
		h.state.emit({ name: "disconnected" });
		expect(h.getToken).not.toHaveBeenCalled();
	});
	test.each([
		"resolve",
		"reject",
	])("shutdown silences a late token %s and removes signals", async (outcome) => {
		let resolve!: (token: string) => void;
		let reject!: (error: Error) => void;
		const h = harness(
			vi.fn(
				() =>
					new Promise<string>((yes, no) => {
						resolve = yes;
						reject = no;
					}),
			),
		);
		h.state.emit({ name: "needs-auth" });
		h.stop();
		h.expired.mockClear();
		if (outcome === "resolve") resolve("late");
		else reject(new Error("late"));
		await flush();
		h.signal();
		h.state.emit({ name: "needs-auth" });
		await vi.advanceTimersByTimeAsync(60000);
		expect(h.connect).not.toHaveBeenCalled();
		expect(h.errors).not.toHaveBeenCalled();
		expect(h.expired).not.toHaveBeenCalled();
		expect(h.stopSignals).toHaveBeenCalled();
	});
	test("does not resurrect a failed pending connect after confirmed connection or shutdown", async () => {
		for (const finish of ["connected", "stop"]) {
			const h = harness();
			let reject!: (error: Error) => void;
			h.connect.mockImplementation(
				() =>
					new Promise<void>((_, no) => {
						reject = no;
					}),
			);
			h.state.emit({ name: "needs-auth" });
			await flush();
			if (finish === "connected") h.state.emit({ name: "connected" });
			else h.stop();
			reject(new Error("late connect"));
			await flush();
			await vi.advanceTimersByTimeAsync(60000);
			expect(h.errors).not.toHaveBeenCalled();
			expect(h.getToken).toHaveBeenCalledTimes(1);
		}
	});
});
test.each([
	401, 403,
])("fetchZeroToken classifies endpoint %s as session refusal", async (status) => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status })),
	);
	await expect(fetchZeroToken()).rejects.toBeInstanceOf(SessionExpiredError);
});
