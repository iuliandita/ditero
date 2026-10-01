import { describe, expect, test, vi } from "vitest";
import {
	EMPTY_SNACKBAR,
	snackbarReducer,
} from "../components/ui/snackbar-state.ts";
import { runBatch } from "./bulk-batch.ts";

const ok = { type: "success" };
const appError = { type: "error", error: { type: "app", message: "denied" } };
const dropped = { type: "error", error: { type: "zero", message: "closed" } };

function mutation(client: unknown, server: unknown = ok) {
	return { client: Promise.resolve(client), server: Promise.resolve(server) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runBatch", () => {
	test("collects only the writes that failed", async () => {
		const results: Record<string, ReturnType<typeof mutation>> = {
			a: mutation(ok),
			b: mutation(ok, appError),
			c: mutation(appError),
		};
		const onFailure = vi.fn();
		const failed = runBatch(
			[{ id: "a" }, { id: "b" }, { id: "c" }],
			(item) => results[item.id],
			() => {},
			onFailure,
		);
		await flush();
		expect([...failed].sort()).toEqual(["b", "c"]);
		expect(onFailure).toHaveBeenLastCalledWith(2);
	});

	test("a connection drop on the server answer is not a failure", async () => {
		const failed = runBatch(
			[{ id: "a" }],
			() => mutation(ok, dropped),
			() => {},
			() => {},
		);
		await flush();
		expect(failed.size).toBe(0);
	});
});

describe("bulk snack with a separate failure key", () => {
	test("a failure waits behind the confirmation and leaves its Undo", () => {
		const undo = { label: "Undo", run: () => {} };
		const shown = snackbarReducer(EMPTY_SNACKBAR, {
			type: "show",
			key: "bulk:1",
			message: "Completed 3 tasks.",
			action: undo,
		});
		const failed = snackbarReducer(shown, {
			type: "fail",
			key: "bulk-failed:1",
			message: "Could not complete 1 task",
		});
		expect(failed.snack?.action).toBe(undo);
		expect(failed.queue).toEqual([
			{ key: "bulk-failed:1", message: "Could not complete 1 task" },
		]);
		const recounted = snackbarReducer(failed, {
			type: "fail",
			key: "bulk-failed:1",
			message: "Could not complete 2 tasks",
		});
		expect(recounted.queue).toEqual([
			{ key: "bulk-failed:1", message: "Could not complete 2 tasks" },
		]);
	});
});
