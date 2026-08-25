import type { Pool } from "pg";

// zero-cache stores each client's lastMutationID in a shard schema it owns. The
// push endpoint writes that row inside the mutation's own transaction, so the
// runtime role needs DML there. Without it every mutation fails with a bare
// "permission denied for schema zero_0" that surfaces only in the browser
// console, long after the stack has reported itself healthy.
export const DEFAULT_ZERO_SHARD_SCHEMA = "zero_0";

export function zeroShardSchema(
	env: Record<string, string | undefined>,
): string {
	return env.DITERO_ZERO_SHARD_SCHEMA || DEFAULT_ZERO_SHARD_SCHEMA;
}

export type ShardAccess = {
	schema: string;
	// Absent means zero-cache has not booted yet, which resolves itself.
	schemaExists: boolean;
	schemaUsable: boolean;
	// Null while zero-cache has not created the table yet.
	clientsWritable: boolean | null;
};

export class ZeroShardAccessError extends Error {
	constructor(schema: string, detail: string) {
		super(
			`Runtime database role cannot ${detail} Zero's shard schema "${schema}", ` +
				"so every mutation will fail. Grant it access to the schema zero-cache " +
				"owns, and set matching default privileges for the role zero-cache " +
				"connects as. See docs/runbooks/database-roles.md.",
		);
	}
}

// A missing schema is not a failure: on a first boot the app can win the race
// against zero-cache creating it, and the next mutation will find it. Present
// but inaccessible never resolves itself, so it is fatal.
export function assertZeroShardAccess(access: ShardAccess): void {
	if (!access.schemaExists) return;
	if (!access.schemaUsable) {
		throw new ZeroShardAccessError(access.schema, "use");
	}
	if (access.clientsWritable === false) {
		throw new ZeroShardAccessError(access.schema, "write the clients table in");
	}
}

export async function verifyZeroShardAccess(
	pool: Pool,
	schema: string,
): Promise<void> {
	// Joined against pg_namespace rather than passed by name: the name form of
	// has_schema_privilege raises when the schema does not exist, which is the
	// one case this check must treat as benign.
	const result = await pool.query<{
		schema_exists: boolean;
		schema_usable: boolean;
		clients_writable: boolean | null;
	}>(
		`select n.oid is not null as schema_exists,
		        coalesce(has_schema_privilege(current_user, n.oid, 'USAGE'), false)
		          as schema_usable,
		        (select has_table_privilege(
		                  current_user, c.oid, 'SELECT, INSERT, UPDATE')
		         from pg_class c
		         where c.relnamespace = n.oid and c.relname = 'clients')
		          as clients_writable
		 from (select 1) probe
		 left join pg_namespace n on n.nspname = $1`,
		[schema],
	);
	const row = result.rows[0];
	if (!row) throw new Error("Unable to inspect Zero's shard schema");
	assertZeroShardAccess({
		schema,
		schemaExists: row.schema_exists,
		schemaUsable: row.schema_usable,
		clientsWritable: row.clients_writable,
	});
}
