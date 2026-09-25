import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { taskActivationSql } from "./task-activation.ts";
import {
	taskActivationClientFromDrizzle,
	withDrizzleProducerActivationScan,
	withDrizzleProducerTaskActivation,
} from "./task-activation-drizzle.ts";

type Transaction = Parameters<typeof taskActivationClientFromDrizzle>[0];

function transactionFixture(options: { autocommit?: boolean } = {}) {
	const dialect = new PgDialect();
	let scope: string | null = null;
	const executed: { text: string; params: unknown[] }[] = [];
	const execute = vi.fn(async (statement: SQL) => {
		const { sql: text, params } = dialect.sqlToQuery(statement);
		executed.push({ text, params });
		if (text.includes("set_config('ditero.activation_scope'")) {
			scope = text.includes("'', true") ? "" : (params[0] as string);
			const result = { rows: [{ scope }] };
			if (options.autocommit) scope = "";
			return result;
		}
		if (text.includes("current_setting('ditero.activation_scope'")) {
			if (text.includes("LEFT JOIN task_notification_activation")) {
				return {
					rows: [
						{
							task_id: params[0],
							scope,
							guard_task_id: null,
							status: null,
							generation: null,
							import_occurrence_cutoff: null,
							recipient_generation_cutoff: null,
							completion_mode: null,
						},
					],
				};
			}
			return { rows: [{ scope }] };
		}
		if (text.includes("FROM task WHERE")) {
			return { rows: [{ id: params[0] }] };
		}
		throw new Error(`Unexpected SQL: ${text}`);
	});
	const tx = { execute } as unknown as Transaction;
	return { tx, executed };
}

describe("Drizzle producer activation bridge", () => {
	it("binds an attacker-shaped task ID and uses the same transaction for lookup and callback", async () => {
		const taskId = "task'; DROP TABLE task; -- $2";
		const { tx, executed } = transactionFixture();
		const result = await withDrizzleProducerTaskActivation(
			tx,
			taskId,
			async (lookup, callbackTx) => {
				expect(callbackTx).toBe(tx);
				expect(lookup).toEqual({ kind: "native", taskId });
				return "ok";
			},
		);
		expect(result).toBe("ok");
		const taskQueries = executed.filter(
			(row) =>
				row.text.includes("FROM task WHERE") ||
				row.text.includes("FROM task t"),
		);
		expect(taskQueries).toHaveLength(2);
		for (const row of taskQueries) {
			expect(row.text).not.toContain(taskId);
			expect(row.params).toEqual([taskId]);
		}
		expect(executed.at(-1)?.text).toContain(
			"set_config('ditero.activation_scope', '', true)",
		);
	});

	it("rejects unsupported SQL and placeholder shapes before execution", async () => {
		const { tx, executed } = transactionFixture();
		const client = taskActivationClientFromDrizzle(tx);
		await expect(client.query("SELECT $1", ["unsafe"])).rejects.toThrow(
			/Unsupported/,
		);
		await expect(client.query(taskActivationSql.lockProducer)).rejects.toThrow(
			/parameters/,
		);
		await expect(
			client.query(taskActivationSql.lockProducer, ["a", "b"]),
		).rejects.toThrow(/parameters/);
		await expect(
			client.query(taskActivationSql.readScope, ["extra"]),
		).rejects.toThrow(/parameters/);
		expect(executed).toEqual([]);
	});

	it("scan scope is temporary and cannot nest into a task lookup", async () => {
		const { tx, executed } = transactionFixture();
		await withDrizzleProducerActivationScan(tx, async (callbackTx) => {
			expect(callbackTx).toBe(tx);
			await expect(
				withDrizzleProducerTaskActivation(tx, "task", async () => {}),
			).rejects.toThrow(/Nested/);
		});
		expect(executed.some((row) => row.text.includes("FROM task WHERE"))).toBe(
			false,
		);
		expect(executed.at(-1)?.text).toContain(
			"set_config('ditero.activation_scope', '', true)",
		);
	});

	it("fails closed when SET LOCAL does not persist", async () => {
		const { tx, executed } = transactionFixture({ autocommit: true });
		await expect(
			withDrizzleProducerActivationScan(tx, async () => {}),
		).rejects.toThrow(/transaction/);
		expect(executed).toHaveLength(3);
	});
});
