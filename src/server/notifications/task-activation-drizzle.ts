import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { QueryResultRow } from "pg";
import type * as tables from "../../db/schema.ts";
import {
	type TaskActivationClient,
	type TaskActivationLookup,
	taskActivationSql,
	withProducerActivationScan,
	withProducerTaskActivation,
} from "./task-activation.ts";

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const statements = new Set<string>(Object.values(taskActivationSql));

// The adapter accepts only the lookup helper's fixed SQL. Drizzle binds the one
// dynamic value on the transaction's connection; callback SQL uses tx directly.
export function taskActivationClientFromDrizzle(
	tx: Transaction,
): TaskActivationClient {
	return {
		async query<Row extends QueryResultRow>(query: string, values?: unknown[]) {
			if (!statements.has(query)) {
				throw new Error("Unsupported task activation SQL");
			}
			const placeholders = query.match(/\$\d+/g) ?? [];
			if (placeholders.length === 0 && (values?.length ?? 0) === 0) {
				const result = await tx.execute<Row>(sql.raw(query));
				return { rows: result.rows as Row[] };
			}
			if (
				placeholders.length !== 1 ||
				placeholders[0] !== "$1" ||
				values?.length !== 1
			) {
				throw new Error("Unsupported task activation SQL parameters");
			}
			const index = query.indexOf("$1");
			const result = await tx.execute<Row>(
				sql`${sql.raw(query.slice(0, index))}${values[0]}${sql.raw(query.slice(index + 2))}`,
			);
			return { rows: result.rows as Row[] };
		},
	};
}

export function withDrizzleProducerTaskActivation<T>(
	tx: Transaction,
	taskId: string,
	callback: (lookup: TaskActivationLookup, tx: Transaction) => Promise<T>,
): Promise<T> {
	return withProducerTaskActivation(
		taskActivationClientFromDrizzle(tx),
		taskId,
		(lookup) => callback(lookup, tx),
	);
}

// This authorizes only a preliminary producer scan, never an enqueue. A later
// transaction must use the task-locked lookup immediately before writing.
export function withDrizzleProducerActivationScan<T>(
	tx: Transaction,
	callback: (tx: Transaction) => Promise<T>,
): Promise<T> {
	return withProducerActivationScan(taskActivationClientFromDrizzle(tx), () =>
		callback(tx),
	);
}
