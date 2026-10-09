// Optional bundle migrations hold one database session advisory lock.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";
import { withMigrationLock } from "./migration-lock.mjs";

const connectionString = process.env.DATABASE_URL;
if (!connectionString)
	throw new Error("DATABASE_URL is required for migrations");
const client = new Client({
	connectionString,
	connectionTimeoutMillis: 5000,
	keepAlive: true,
	keepAliveInitialDelayMillis: 1000,
	application_name: "ditero-aio-migrate",
});
try {
	await withMigrationLock(client, async (sameClient) => {
		await migrate(drizzle(sameClient), { migrationsFolder: "/app/drizzle" });
	});
} catch {
	// PostgreSQL errors may contain schema/data; do not emit raw driver errors.
	console.error("ditero: migration failed");
	process.exitCode = 1;
}
