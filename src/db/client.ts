// Shared drizzle client (node-postgres pool) for the whole app.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:pass@localhost:5432/ditero",
});
export const db = drizzle(pool, { schema });
