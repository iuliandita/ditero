// Deterministic seed for the M0 spine e2e.
// Creates a system-owned SHARED workspace with one list. New signups auto-join it
// via DITERO_DEFAULT_WORKSPACE_ID (the auth bootstrap hook), so both test users
// share a list, while each keeps a private personal workspace of their own.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as s from "./schema.ts";

export const SHARED_WORKSPACE_ID = "w_shared_e2e";
const SYSTEM_USER_ID = "u_system_e2e";
const SHARED_LIST_ID = "l_shared_e2e";

async function main() {
	const pool = new Pool({
		connectionString:
			process.env.DATABASE_URL ??
			"postgres://postgres:pass@localhost:5432/ditero",
	});
	const db = drizzle(pool, { schema: s });

	// Clean slate, FK-safe order (session/account also cascade from user).
	await db.delete(s.task);
	await db.delete(s.list);
	await db.delete(s.membership);
	await db.delete(s.workspace);
	await db.delete(s.session);
	await db.delete(s.account);
	await db.delete(s.user);

	await db.insert(s.user).values({
		id: SYSTEM_USER_ID,
		name: "System",
		email: "system@ditero.local",
	});
	await db.insert(s.workspace).values({
		id: SHARED_WORKSPACE_ID,
		name: "Household",
		ownerId: SYSTEM_USER_ID,
		kind: "shared",
	});
	await db.insert(s.list).values({
		id: SHARED_LIST_ID,
		workspaceId: SHARED_WORKSPACE_ID,
		ownerId: SYSTEM_USER_ID,
		title: "Shared list",
		visibility: "workspace",
	});

	await pool.end();
	console.log("seed-e2e: ok");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
