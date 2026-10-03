import { expect, test, vi } from "vitest";
import { appearanceSaveSucceeded } from "./appearance-save.ts";

test("accepted local writes remain pending until their server acknowledgment", async () => {
	let acknowledge!: (value: { type: string }) => void;
	const server = new Promise<{ type: string }>((resolve) => {
		acknowledge = resolve;
	});
	const accepted = vi.fn();
	let finished = false;
	const result = appearanceSaveSucceeded(
		{ client: Promise.resolve({ type: "success" }), server },
		accepted,
	).then((saved) => {
		finished = true;
		return saved;
	});
	await Promise.resolve();
	await Promise.resolve();
	expect(accepted).toHaveBeenCalledOnce();
	expect(finished).toBe(false);
	acknowledge({ type: "success" });
	await expect(result).resolves.toBe(true);
});
test("server refusal never becomes Saved after optimistic acceptance", async () => {
	const accepted = vi.fn();
	await expect(
		appearanceSaveSucceeded(
			{
				client: Promise.resolve({ type: "success" }),
				server: Promise.resolve({ type: "error" }),
			},
			accepted,
		),
	).resolves.toBe(false);
	expect(accepted).toHaveBeenCalledOnce();
});
test("local refusal and rejected server acknowledgment are reported without throwing", async () => {
	const accepted = vi.fn();
	await expect(
		appearanceSaveSucceeded(
			{
				client: Promise.resolve({ type: "error" }),
				server: Promise.resolve({ type: "success" }),
			},
			accepted,
		),
	).resolves.toBe(false);
	expect(accepted).not.toHaveBeenCalled();
	await expect(
		appearanceSaveSucceeded(
			{
				client: Promise.resolve({ type: "success" }),
				server: Promise.reject(new Error("unavailable")),
			},
			accepted,
		),
	).resolves.toBe(false);
});
