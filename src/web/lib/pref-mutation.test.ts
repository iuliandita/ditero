import { describe, expect, test } from "vitest";
import { mutationServerSucceeded } from "./pref-mutation.ts";

describe("mutationServerSucceeded", () => {
	test("does not report success before the server result arrives", async () => {
		let resolveServer!: (result: { type: "success" }) => void;
		const server = new Promise<{ type: "success" }>((resolve) => {
			resolveServer = resolve;
		});
		let settled = false;
		const result = mutationServerSucceeded({ server }).then((value) => {
			settled = true;
			return value;
		});

		await Promise.resolve();
		expect(settled).toBe(false);

		resolveServer({ type: "success" });
		await expect(result).resolves.toBe(true);
	});

	test("returns false for a server-side mutation error", async () => {
		await expect(
			mutationServerSucceeded({
				server: Promise.resolve({ type: "error" }),
			}),
		).resolves.toBe(false);
	});

	test("returns false when the server promise rejects", async () => {
		await expect(
			mutationServerSucceeded({
				server: Promise.reject(new Error("offline")),
			}),
		).resolves.toBe(false);
	});
});
