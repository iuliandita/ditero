// Shared drizzle client for backend-owned tables (reminders, channels).
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as s from "./schema.ts";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://postgres:pass@localhost:5432/ditero_spike",
});
export const db = drizzle(pool, { schema: s });
