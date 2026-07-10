import { describe, expect, test, vi } from "vitest";
import { watchZeroAuth } from "./zero-auth.ts";

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
});
