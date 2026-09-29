import { describe, expect, it, vi } from "vitest";
import { onMutationFailure } from "./mutation-outcome.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
// What Zero 1.9's mutator proxy resolves: it never rejects.
const ok = () => Promise.resolve({ type: "success" });
const refused = (message: string) =>
	Promise.resolve({ type: "error", error: { type: "app", message } });

describe("onMutationFailure", () => {
	it("stays quiet when both halves succeed", async () => {
		const onFail = vi.fn();
		onMutationFailure({ client: ok(), server: ok() }, onFail);
		await settle();
		expect(onFail).not.toHaveBeenCalled();
	});

	it("fires on a client error result", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{ client: refused("need member+"), server: ok() },
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});

	it("fires on a server error result", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{ client: ok(), server: refused("need member+") },
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});

	it("fires once when both halves report an error", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{ client: refused("need member+"), server: refused("need member+") },
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});
});
