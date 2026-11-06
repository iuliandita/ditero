import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as tables from "../../db/schema.ts";

export async function warnNotificationChannelState(
	database: NodePgDatabase<typeof tables>,
	warn: (message: string) => void = console.warn,
): Promise<void> {
	const { rows } = await database.execute<{
		unconfirmed: number;
		legacy: number;
	}>(sql`
  select count(*) filter (where kind='email' and enabled and ack_verified_at is null)::integer as unconfirmed,
   count(*) filter (where exists (
    select 1 from jsonb_each(config) field
    where jsonb_typeof(field.value)='string' and field.value #>> '{}' like 'ditero:v1:%'
   ))::integer as legacy
  from notification_channel`);
	const { unconfirmed, legacy } = rows[0];
	if (unconfirmed)
		warn(
			`notifications: ${unconfirmed} enabled email channel(s) need recipient confirmation; queued mail for these channels is discarded. Use Send test and redeem the emailed link.`,
		);
	if (legacy)
		warn(
			`notifications: ${legacy} channel(s) still use unbound legacy encryption. Run security:encrypt-channel-configs and verify delivery before retiring old keys.`,
		);
}
