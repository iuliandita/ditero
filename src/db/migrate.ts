import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
	throw new Error("DATABASE_URL is required for migrations");

const pool = new Pool({ connectionString, max: 1 });
try {
	await migrate(drizzle(pool), {
		migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)),
	});
} finally {
	await pool.end();
}
