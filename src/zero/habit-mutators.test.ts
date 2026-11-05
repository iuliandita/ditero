import type { Transaction } from "@rocicorp/zero";
import { describe, expect, test, vi } from "vitest";
import { mutators } from "./mutators.ts";
import type { Schema } from "./schema.gen.ts";

function transaction(existing: unknown = undefined, role = "member") {
	const habit = { id: "habit", priority: 0, list: { workspaceId: "space" } };
	const insert = vi.fn();
	const update = vi.fn();
	const award = vi.fn();
	// Only the transaction adapter is stubbed; the real mutator, validation,
	// optimistic authorization, and Karma calculation run here.
	const tx = {
		location: "client",
		run: vi
			.fn()
			.mockResolvedValueOnce(habit)
			.mockResolvedValueOnce([{ role }])
			.mockResolvedValueOnce(habit)
			.mockResolvedValueOnce(existing)
			.mockResolvedValue(undefined),
		mutate: {
			habitLog: { insert, update },
			karma: { insert: award },
			karmaEvent: { insert: vi.fn() },
		},
	} as unknown as Transaction<Schema>;
	return { tx, insert, update, award };
}

const args = { habitId: "habit", date: "2026-11-05", status: "done" as const };

describe("optimistic habit attribution", () => {
	test("attributes a new completion to context, ignoring a supplied actor", async () => {
		const { tx, insert, award } = transaction();
		const spoofed = { ...args, completedBy: "mallory" };
		await mutators.habit.log.fn({ tx, ctx: { id: "alice" }, args: spoofed });
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				completedBy: "alice",
				status: "done",
				karmaDelta: 3,
			}),
		);
		expect(award).toHaveBeenCalledOnce();
	});

	test("a repeated tick preserves the first actor, time, and award", async () => {
		const { tx, insert, update, award } = transaction({
			id: "log",
			status: "done",
			completedBy: "bob",
			completedAt: 123,
			karmaDelta: 3,
		});
		await mutators.habit.log.fn({ tx, ctx: { id: "alice" }, args });
		expect(insert).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
		expect(award).not.toHaveBeenCalled();
	});

	test("skipping clears completion attribution", async () => {
		const { tx, update } = transaction({
			id: "log",
			status: "done",
			completedBy: "alice",
			karmaDelta: 3,
		});
		await mutators.habit.log.fn({
			tx,
			ctx: { id: "alice" },
			args: { ...args, status: "skipped" },
		});
		expect(update).toHaveBeenCalledWith(
			expect.objectContaining({
				completedBy: null,
				completedAt: null,
				karmaDelta: 0,
			}),
		);
	});

	test("a viewer cannot write attribution", async () => {
		const { tx, insert } = transaction(undefined, "viewer");
		await expect(
			mutators.habit.log.fn({ tx, ctx: { id: "alice" }, args }),
		).rejects.toThrow(/access denied/);
		expect(insert).not.toHaveBeenCalled();
	});
});
