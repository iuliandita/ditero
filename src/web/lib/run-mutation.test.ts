import { describe, expect, it, vi } from "vitest";
import { mutationResultError, runMutation } from "./run-mutation.ts";

describe("mutationResultError", () => {
	it("reads Zero's resolved error result", () => {
		expect(
			mutationResultError({ type: "error", error: { message: "nope" } }),
		).toBe("nope");
		expect(mutationResultError({ type: "error" })).toBe("");
		expect(mutationResultError({ type: "success" })).toBeNull();
		expect(mutationResultError(undefined)).toBeNull();
	});
});

describe("runMutation", () => {
	it("reports success without calling onError", async () => {
		const onError = vi.fn();
		expect(
			await runMutation(
				{ client: Promise.resolve({ type: "success" }) },
				onError,
			),
		).toBe(true);
		expect(onError).not.toHaveBeenCalled();
	});

	it("routes a resolved error result to onError", async () => {
		const onError = vi.fn();
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(
			await runMutation(
				{
					client: Promise.resolve({
						type: "error",
						error: { type: "app", message: "task not found" },
					}),
				},
				onError,
			),
		).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0][0]).toEqual(expect.any(String));
		expect(onError.mock.calls[0][0]).not.toBe("");
	});
});
