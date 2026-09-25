import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, it, vi } from "vitest";
import { withProducerAuthority } from "./producer-authority.ts";

type Transaction = Parameters<typeof withProducerAuthority>[0];

it("rejects invalid candidates before querying or entering producer scope", async () => {
	const execute = vi.fn();
	const tx = { execute } as unknown as Transaction;
	await expect(
		withProducerAuthority(
			tx,
			{
				kind: "reminder",
				taskId: "",
				recipientUserId: "recipient",
				occurrenceAt: new Date(),
			},
			async () => "sent",
		),
	).rejects.toThrow(/required/);
	await expect(
		withProducerAuthority(
			tx,
			{
				kind: "reminder",
				taskId: "task",
				recipientUserId: "recipient",
				occurrenceAt: new Date(Number.NaN),
			},
			async () => "sent",
		),
	).rejects.toThrow(/occurrence/);
	expect(execute).not.toHaveBeenCalled();
});

it("skips a task absent at prediscovery without invoking the callback", async () => {
	const dialect = new PgDialect();
	const execute = vi.fn(async (statement: SQL) => {
		const query = dialect.sqlToQuery(statement);
		expect(query.sql).toContain("from task t join list l");
		expect(query.params).toEqual(["missing"]);
		return { rows: [] };
	});
	const tx = { execute } as unknown as Transaction;
	const callback = vi.fn(async () => "sent");
	await expect(
		withProducerAuthority(
			tx,
			{ kind: "overdue", taskId: "missing", recipientUserId: "user" },
			callback,
		),
	).resolves.toEqual({ kind: "skip" });
	expect(callback).not.toHaveBeenCalled();
	expect(execute).toHaveBeenCalledTimes(1);
});
