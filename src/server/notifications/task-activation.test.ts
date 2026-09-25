import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
	withAccountDeletionTaskActivation,
	withAckTaskActivation,
	withInviteTaskActivation,
	withProducerActivationScan,
	withProducerTaskActivation,
} from "./task-activation.ts";

const taskId = "task-1";
const now = new Date("2026-09-21T12:00:00Z");

function nativeRow() {
	return {
		task_id: taskId,
		scope: "producer",
		guard_task_id: null,
		status: null,
		generation: null,
		import_occurrence_cutoff: null,
		recipient_generation_cutoff: null,
		completion_mode: null,
	};
}

function clientFixture(
	options: {
		scope?: string | null;
		autocommit?: boolean;
		missingTask?: boolean;
		envelope?: Record<string, unknown> | null;
	} = {},
) {
	let scope = options.scope ?? null;
	const calls: string[] = [];
	const query = vi.fn(async (sql: string, values?: unknown[]) => {
		calls.push(sql);
		if (sql.includes("set_config('ditero.activation_scope'")) {
			scope = (values?.[0] as string | undefined) ?? "";
			const result = { rows: [{ scope }] };
			if (options.autocommit) scope = "";
			return result;
		}
		if (
			sql.includes("current_setting('ditero.activation_scope'") &&
			!sql.includes("FROM task")
		) {
			return { rows: [{ scope }] };
		}
		if (sql.includes("FROM task WHERE")) {
			return { rows: options.missingTask ? [] : [{ id: taskId }] };
		}
		if (sql.includes("LEFT JOIN task_notification_activation")) {
			if (options.envelope === null) return { rows: [] };
			return {
				rows: [{ ...nativeRow(), scope, ...options.envelope }],
			};
		}
		throw new Error(`Unexpected query: ${sql}`);
	});
	return { client: { query } as unknown as PoolClient, calls, query };
}

describe("task activation lookup", () => {
	it.each([
		["producer", withProducerTaskActivation, "FOR SHARE"],
		["invite", withInviteTaskActivation, "FOR UPDATE"],
		["ack", withAckTaskActivation, "FOR UPDATE"],
		["account-delete", withAccountDeletionTaskActivation, "FOR UPDATE"],
	] as const)("uses the %s scope and lock on the caller's client", async (purpose, run, lock) => {
		const { client, calls, query } = clientFixture();
		const result = await run(client, taskId, async (lookup, callbackClient) => {
			expect(callbackClient).toBe(client);
			expect(lookup).toEqual({ kind: "native", taskId });
			expect(calls.at(-1)).toContain("LEFT JOIN task_notification_activation");
			return 17;
		});
		expect(result).toBe(17);
		expect(query.mock.calls[1]?.[1]).toEqual([purpose]);
		expect(calls[3]).toContain(lock);
		expect(calls.at(-1)).toContain(
			"set_config('ditero.activation_scope', '', true)",
		);
		expect(calls.every((sql) => !/\bBEGIN\b|\bCOMMIT\b/.test(sql))).toBe(true);
	});

	it("returns a validated guarded lookup", async () => {
		const { client } = clientFixture({
			envelope: {
				guard_task_id: taskId,
				status: "active",
				generation: 3,
				import_occurrence_cutoff: now,
				recipient_generation_cutoff: now,
				completion_mode: "import",
			},
		});
		await withProducerTaskActivation(client, taskId, async (lookup) => {
			expect(lookup).toEqual({
				kind: "guarded",
				taskId,
				status: "active",
				generation: 3,
				importOccurrenceCutoff: now,
				recipientGenerationCutoff: now,
				completionMode: "import",
			});
		});
	});

	it.each(["", "  "])("rejects empty task ID %j before SQL", async (id) => {
		const { client, query } = clientFixture();
		await expect(
			withProducerTaskActivation(client, id, async () => {}),
		).rejects.toThrow();
		expect(query).not.toHaveBeenCalled();
	});

	it("rejects a nested scope without overwriting it", async () => {
		const { client, calls } = clientFixture({ scope: "invite" });
		await expect(
			withProducerTaskActivation(client, taskId, async () => {}),
		).rejects.toThrow(/Nested/);
		expect(calls).toHaveLength(1);
	});

	it("fails closed outside an existing transaction", async () => {
		const { client, calls } = clientFixture({ autocommit: true });
		await expect(
			withProducerTaskActivation(client, taskId, async () => {}),
		).rejects.toThrow(/transaction/);
		expect(calls).toHaveLength(3);
	});

	it("requires a locked task and a complete guard envelope", async () => {
		const absent = clientFixture({ missingTask: true });
		await expect(
			withProducerTaskActivation(absent.client, taskId, async () => {}),
		).rejects.toThrow(/envelope/);
		const missing = clientFixture({ envelope: null });
		await expect(
			withProducerTaskActivation(missing.client, taskId, async () => {}),
		).rejects.toThrow(/envelope/);
	});

	it.each([
		[{ scope: "ack" }, /scope/],
		[{ guard_task_id: null, status: "active" }, /native envelope/],
		[{ guard_task_id: taskId, status: "unknown", generation: 1 }, /status/],
		[{ guard_task_id: taskId, status: "pending", generation: 0 }, /generation/],
		[{ guard_task_id: taskId, status: "active", generation: 1 }, /cutoffs/],
		[
			{
				guard_task_id: taskId,
				status: "active",
				generation: 1,
				import_occurrence_cutoff: now,
				recipient_generation_cutoff: now,
			},
			/completion mode/,
		],
		[
			{
				guard_task_id: taskId,
				status: "pending",
				generation: 1,
				completion_mode: "import",
			},
			/completion mode/,
		],
		[
			{
				guard_task_id: taskId,
				status: "active",
				generation: 1,
				import_occurrence_cutoff: now,
				recipient_generation_cutoff: new Date(now.getTime() - 1),
				completion_mode: "import",
			},
			/recipient cutoff precedes import cutoff/,
		],
		[
			{
				guard_task_id: taskId,
				status: "pending",
				generation: 1,
				import_occurrence_cutoff: "bad",
			},
			/cutoff/,
		],
	] as const)("rejects malformed or mismatched guard evidence", async (envelope, message) => {
		const { client } = clientFixture({ envelope });
		await expect(
			withProducerTaskActivation(client, taskId, async () => {}),
		).rejects.toThrow(message);
	});

	it("does not mask a callback error or clear scope before outer rollback", async () => {
		const { client, calls } = clientFixture();
		const failure = new Error("writer failed");
		await expect(
			withProducerTaskActivation(client, taskId, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(calls.at(-1)).toContain("LEFT JOIN task_notification_activation");
	});
});

describe("preliminary producer scan scope", () => {
	it("exposes producer evidence only inside the callback and clears afterward", async () => {
		const { client, calls } = clientFixture();
		const value = await withProducerActivationScan(client, async (scoped) => {
			expect(scoped).toBe(client);
			expect(
				(
					await scoped.query<{ scope: string }>(
						"SELECT current_setting('ditero.activation_scope', true) AS scope",
					)
				).rows[0]?.scope,
			).toBe("producer");
			return 7;
		});
		expect(value).toBe(7);
		expect(calls.some((sql) => sql.includes("FROM task WHERE"))).toBe(false);
		expect(calls.at(-1)).toContain(
			"set_config('ditero.activation_scope', '', true)",
		);
	});

	it("rejects a nested scan without changing the caller's scope", async () => {
		const { client, calls } = clientFixture({ scope: "ack" });
		await expect(
			withProducerActivationScan(client, async () => {}),
		).rejects.toThrow(/Nested/);
		expect(calls).toHaveLength(1);
	});

	it("requires a transaction and leaves failed callbacks for outer rollback", async () => {
		const autocommit = clientFixture({ autocommit: true });
		await expect(
			withProducerActivationScan(autocommit.client, async () => {}),
		).rejects.toThrow(/transaction/);
		expect(autocommit.calls).toHaveLength(3);

		const { client, calls } = clientFixture();
		const failure = new Error("scan failed");
		await expect(
			withProducerActivationScan(client, async () => {
				throw failure;
			}),
		).rejects.toBe(failure);
		expect(calls.at(-1)).toContain("current_setting");
	});
});
