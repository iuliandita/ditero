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
	// Tables present in the schema that the role cannot write. Empty both when
	// every table is writable and when zero-cache has yet to create any.
	unwritableTables: string[];
};

export class ZeroShardAccessError extends Error {
	constructor(schema: string, detail: string) {
		super(
			`Runtime database role cannot ${detail} in Zero's shard schema "${schema}", ` +
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
		throw new ZeroShardAccessError(access.schema, "use the schema");
	}
	if (access.unwritableTables.length > 0) {
		throw new ZeroShardAccessError(
			access.schema,
			`write ${access.unwritableTables.join(", ")}`,
		);
	}
}

// pg_class.relname is `name`, so aggregating it yields name[] (OID 1003), for
// which node-postgres registers no parser and hands back the raw literal string
// -- turning a boot check into a TypeError. Hence the ::text on the column, and
// this guard: fail on the shape rather than coercing it, or the check silently
// passes on the next such slip.
function unwritableTables(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value)) {
		throw new Error(
			`Zero shard probe returned ${typeof value} for the unwritable table list`,
		);
	}
	return value as string[];
}

export async function verifyZeroShardAccess(
	pool: Pool,
	schema: string,
): Promise<void> {
	// Every table rather than the one the push path is known to write: the case
	// this exists to catch is an operator applying grants by hand against an
	// external Postgres, where covering one table and missing another is exactly
	// the mistake made. DELETE is left out of the probe deliberately -- it is
	// granted, but asserting it would refuse to boot over a privilege the
	// mutation path does not need.
	//
	// One has_table_privilege call per privilege, NOT the comma-separated form:
	// that form is true when ANY of the listed privileges is held, so a
	// read-only grant passes it. This check read as correct and asserted almost
	// nothing until a probe narrowing the grant to SELECT failed to fail.
	//
	// Joined against pg_namespace rather than passed by name: the name form of
	// has_schema_privilege raises when the schema does not exist, which is the
	// one case this check must treat as benign.
	const result = await pool.query<{
		schema_exists: boolean;
		schema_usable: boolean;
		unwritable: unknown;
	}>(
		`select n.oid is not null as schema_exists,
		        coalesce(has_schema_privilege(current_user, n.oid, 'USAGE'), false)
		          as schema_usable,
		        (select coalesce(array_agg(c.relname::text order by c.relname), '{}'::text[])
		         from pg_class c
		         where c.relnamespace = n.oid
		           and c.relkind = 'r'
		           and not (
		                 has_table_privilege(current_user, c.oid, 'SELECT')
		             and has_table_privilege(current_user, c.oid, 'INSERT')
		             and has_table_privilege(current_user, c.oid, 'UPDATE')))
		          as unwritable
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
		unwritableTables: unwritableTables(row.unwritable),
	});
}
