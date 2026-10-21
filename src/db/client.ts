// Shared drizzle client (node-postgres pool) for the whole app.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { postgresReadinessCode } from "./postgres-readiness.ts";
import * as schema from "./schema.ts";

export const pool = new Pool({
	connectionTimeoutMillis: 2_000,
	connectionString:
		process.env.DATABASE_URL ??
		"postgres://postgres:pass@localhost:5432/ditero",
});
// Checked-out clients (including advisory-lock holders) emit outside queries
// too. Never log the client or error object: they can contain credentials/SQL.
pool.on("connect", (client) => {
	client.on("error", (error) => {
		console.error("database: connection lost", {
			code: postgresReadinessCode(error),
		});
	});
});
pool.on("error", (error) => {
	console.error("database: idle connection removed; will reconnect", {
		code: postgresReadinessCode(error),
	});
});
export const db = drizzle(pool, { schema });
