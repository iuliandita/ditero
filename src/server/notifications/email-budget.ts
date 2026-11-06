import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as tables from "../../db/schema.ts";
import { ACK_RATE_IDLE_RESET_MS, takeRateToken } from "./capability.ts";

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

// Shared by verification and scheduled mail, across replicas and address changes.
export const EMAIL_SEND_CAPACITY = 20;
export const EMAIL_SEND_REFILL_PER_SEC = 1 / 60;

export function emailBudgetKey(userId: string): string {
	return `notification-email:${userId}`;
}

export class EmailBudgetExhausted extends Error {}

// Serialize sends for one owner. The charge commits only after SMTP acceptance;
// failed sends leave the budget intact, and exhausted callers never edit config.
export async function withEmailBudget<T extends { ok: boolean }>(
	database: Database,
	userId: string,
	send: (tx: Transaction) => Promise<T>,
): Promise<T> {
	return database.transaction(async (tx) => {
		const key = emailBudgetKey(userId);
		await tx.execute(sql`insert into rate_bucket (key, tokens, refilled_at)
   values (${key}, ${EMAIL_SEND_CAPACITY}, now()) on conflict (key) do nothing`);
		const { rows } = await tx.execute<{ available: boolean }>(sql`
   select (refilled_at < now() - make_interval(secs => ${ACK_RATE_IDLE_RESET_MS / 1000}::double precision)
    or least(${EMAIL_SEND_CAPACITY}, tokens + floor(extract(epoch from now() - refilled_at) * ${EMAIL_SEND_REFILL_PER_SEC}::double precision)) > 0) as available
   from rate_bucket where key=${key} for update`);
		if (!rows[0]?.available)
			throw new EmailBudgetExhausted("notification mail budget exhausted");
		const result = await send(tx);
		if (
			result.ok &&
			!(await takeRateToken(
				tx,
				key,
				EMAIL_SEND_CAPACITY,
				EMAIL_SEND_REFILL_PER_SEC,
			))
		)
			throw new Error("Locked notification mail budget changed during send");
		return result;
	});
}
