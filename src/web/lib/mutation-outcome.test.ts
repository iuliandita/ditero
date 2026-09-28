import { describe, expect, it, vi } from "vitest";
import { onMutationFailure } from "./mutation-outcome.ts";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("onMutationFailure", () => {
	it("stays quiet when both halves succeed", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{
				client: Promise.resolve(),
				server: Promise.resolve({ type: "success" }),
			},
			onFail,
		);
		await settle();
		expect(onFail).not.toHaveBeenCalled();
	});

	it("fires on a client rejection", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{
				client: Promise.reject(new Error("refused")),
				server: Promise.resolve({ type: "success" }),
			},
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});

	it("fires on a server error result, which resolves rather than rejects", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{ client: Promise.resolve(), server: Promise.resolve({ type: "error" }) },
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});

	it("fires once when both halves fail", async () => {
		const onFail = vi.fn();
		onMutationFailure(
			{
				client: Promise.reject(new Error("refused")),
				server: Promise.reject(new Error("offline")),
			},
			onFail,
		);
		await settle();
		expect(onFail).toHaveBeenCalledTimes(1);
	});
});
