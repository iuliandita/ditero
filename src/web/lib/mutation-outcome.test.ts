import { describe, expect, it, vi } from "vitest";
import { onMutationFailure } from "./mutation-outcome.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// The shapes Zero 1.9's mutator proxy resolves; it never rejects.
const ok = () => Promise.resolve({ type: "success" });
const refused = (message: string) =>
	Promise.resolve({ type: "error", error: { type: "app", message } });
const zero = (message: string) =>
	Promise.resolve({ type: "error", error: { type: "zero", message } });

describe("onMutationFailure", () => {
	it("stays quiet when both halves succeed", async () => {
		const onFail = vi.fn();
		onMutationFailure({ client: ok(), server: ok() }, onFail);
		await settle();
		expect(onFail).not.toHaveBeenCalled();
	});

	it("fires on a client error of either kind (the write never applied)", async () => {
		for (const client of [refused("need member+"), zero("Offline")]) {
			const onFail = vi.fn();
			onMutationFailure({ client, server: ok() }, onFail);
			await settle();
			expect(onFail).toHaveBeenCalledTimes(1);
		}
	});

	it("fires on a server refusal", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{ client: ok(), server: refused("need member+") },
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});

	it("ignores a server connection error: the write stays queued and lands", async () => {
		const onFail = vi.fn();
		onMutationFailure({ client: ok(), server: zero("Disconnected") }, onFail);
		await settle();
		expect(onFail).not.toHaveBeenCalled();
	});

	it("fires once when both halves are refused", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{ client: refused("need member+"), server: refused("need member+") },
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});
});
