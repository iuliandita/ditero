import { describe, expect, it, vi } from "vitest";
import { m } from "../../paraglide/messages.js";
import { mutationResultFailure, runMutation } from "./run-mutation.ts";

describe("mutationResultFailure", () => {
	it("reads Zero's resolved error result and its kind", () => {
		expect(
			mutationResultFailure({
				type: "error",
				error: { type: "app", message: "nope" },
			}),
		).toEqual({ kind: "app", message: "nope" });
		expect(
			mutationResultFailure({
				type: "error",
				error: { type: "zero", message: "Offline" },
			}),
		).toEqual({ kind: "zero", message: "Offline" });
		expect(mutationResultFailure({ type: "error" })).toEqual({
			kind: "app",
			message: "",
		});
		expect(mutationResultFailure({ type: "success" })).toBeNull();
		expect(mutationResultFailure(undefined)).toBeNull();
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

	it("routes an application error to the translated failure", async () => {
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
		expect(onError).toHaveBeenCalledWith(m.mutation_failed());
	});

	it("says offline, not failed, when Zero was disconnected", async () => {
		const onError = vi.fn();
		expect(
			await runMutation(
				{
					client: Promise.resolve({
						type: "error",
						error: { type: "zero", message: "Offline" },
					}),
				},
				onError,
			),
		).toBe(false);
		expect(onError).toHaveBeenCalledWith(m.mutation_offline_not_saved());
	});
});
