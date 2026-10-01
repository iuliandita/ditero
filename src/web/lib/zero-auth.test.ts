import { describe, expect, test, vi } from "vitest";
import { SessionExpiredError, watchZeroAuth } from "./zero-auth.ts";

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
			listener?.(state);
		},
	};
}

describe("watchZeroAuth", () => {
	test("coalesces needs-auth events and reconnects with a fresh token", async () => {
		const state = stateSource();
		let releaseToken: ((token: string) => void) | undefined;
		const getToken = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					releaseToken = resolve;
				}),
		);
		const connect = vi.fn(async () => undefined);
		const stop = watchZeroAuth({ connection: { state, connect } }, getToken);

		state.emit({ name: "needs-auth" });
		state.emit({ name: "needs-auth" });
		expect(getToken).toHaveBeenCalledTimes(1);
		releaseToken?.("fresh-token");
		await vi.waitFor(() =>
			expect(connect).toHaveBeenCalledWith({ auth: "fresh-token" }),
		);

		stop();
		state.emit({ name: "needs-auth" });
		expect(getToken).toHaveBeenCalledTimes(1);
	});

	test("ignores non-auth connection states", () => {
		const state = stateSource();
		const getToken = vi.fn(async () => "token");
		watchZeroAuth(
			{ connection: { state, connect: vi.fn(async () => undefined) } },
			getToken,
		);
		state.emit({ name: "disconnected" });
		expect(getToken).not.toHaveBeenCalled();
	});

	test("flags an expired session and retries when the network returns", async () => {
		const state = stateSource();
		state.current = { name: "needs-auth" };
		let retry: (() => void) | undefined;
		const expired = vi.fn();
		const getToken = vi
			.fn<() => Promise<string>>()
			.mockRejectedValueOnce(new SessionExpiredError("401"))
			.mockResolvedValueOnce("fresh-token");
		const connect = vi.fn(async () => undefined);
		watchZeroAuth({ connection: { state, connect } }, getToken, () => {}, {
			onSessionExpired: expired,
			retrySignals: (fn) => {
				retry = fn;
				return () => {};
			},
		});
		await vi.waitFor(() => expect(expired).toHaveBeenLastCalledWith(true));
		expect(connect).not.toHaveBeenCalled();
		retry?.();
		await vi.waitFor(() =>
			expect(connect).toHaveBeenCalledWith({ auth: "fresh-token" }),
		);
		expect(expired).toHaveBeenLastCalledWith(false);
	});
	test.each([
		"needs-auth",
		"connected",
		"stopped",
	])("handles a retry signal during a pending refresh when %s", async (nextState) => {
		const state = stateSource();
		state.current = { name: "needs-auth" };
		let rejectToken: ((error: Error) => void) | undefined;
		let retry: (() => void) | undefined;
		const getToken = vi
			.fn<() => Promise<string>>()
			.mockImplementationOnce(
				() =>
					new Promise((_, reject) => {
						rejectToken = reject;
					}),
			)
			.mockResolvedValue("fresh-token");
		const connect = vi.fn(async () => undefined);
		const onError = vi.fn();
		const stop = watchZeroAuth(
			{ connection: { state, connect } },
			getToken,
			onError,
			{
				retrySignals: (fn) => {
					retry = fn;
					return () => {};
				},
			},
		);
		retry?.();
		retry?.();
		expect(getToken).toHaveBeenCalledTimes(1);
		if (nextState === "stopped") stop();
		else state.current = { name: nextState };
		rejectToken?.(new Error("offline"));
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
		if (nextState === "needs-auth") {
			await vi.waitFor(() =>
				expect(connect).toHaveBeenCalledWith({ auth: "fresh-token" }),
			);
			expect(getToken).toHaveBeenCalledTimes(2);
		} else {
			expect(getToken).toHaveBeenCalledTimes(1);
			expect(connect).not.toHaveBeenCalled();
		}
		stop();
	});

	test("does not retry a refused refresh from duplicate needs-auth emissions", async () => {
		const state = stateSource();
		state.current = { name: "needs-auth" };
		let rejectToken: ((error: Error) => void) | undefined;
		const getToken = vi.fn(
			() =>
				new Promise<string>((_, reject) => {
					rejectToken = reject;
				}),
		);
		const onError = vi.fn();
		const stop = watchZeroAuth(
			{ connection: { state, connect: vi.fn() } },
			getToken,
			onError,
		);
		state.emit({ name: "needs-auth" });
		rejectToken?.(new SessionExpiredError("401"));
		await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
		expect(getToken).toHaveBeenCalledTimes(1);
		stop();
	});
});
