// The listener seam's DB-backed rate limiter against a real Postgres. The pure
// seam logic is unit-tested; what needs a database is the limiter it wraps --
// M3a shipped two production bugs in exactly this statement (refill gated
// behind already having tokens, and an integer type inference that made a
// fractional rate abort), both hidden by a `refillPerSec: 0` fixture. So the
// fixture here uses the fractional default rate on purpose.
import { like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { takeRateToken } from "../../src/server/notifications/capability.ts";
import { dbRateLimit } from "../../src/server/notifications/raw-body.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL, max: 4 });
const db = drizzle(pool, { schema: tables });

const IP = "203.0.113.77";

afterAll(async () => {
	await pool.end();
});

beforeEach(async () => {
	await db
		.delete(tables.rateBucket)
		.where(like(tables.rateBucket.key, `%${IP}`));
});

describe("listener rate limit", () => {
	test("runs at a fractional refill rate without aborting", async () => {
		const limit = dbRateLimit(db, {
			keyPrefix: "telegram:",
			capacity: 2,
			refillPerSec: 0.5,
		});

		expect(await limit(IP)).toBe(true);
		expect(await limit(IP)).toBe(true);
		expect(await limit(IP)).toBe(false);
	});

	// Same table as the ack route, so the prefix is the only thing keeping a
	// flood on a public listener from spending the ack budget for that address.
	test("leaves the ack bucket for the same address untouched", async () => {
		const limit = dbRateLimit(db, {
			keyPrefix: "slack:",
			capacity: 1,
			refillPerSec: 0.5,
		});

		expect(await limit(IP)).toBe(true);
		expect(await limit(IP)).toBe(false);

		expect(await takeRateToken(db, `ack:${IP}`, 1, 0.5)).toBe(true);

		const keys = (
			await db
				.select({ key: tables.rateBucket.key })
				.from(tables.rateBucket)
				.where(like(tables.rateBucket.key, `%${IP}`))
		).map((row) => row.key);
		expect(keys.sort()).toEqual([`ack:${IP}`, `slack:${IP}`]);
	});
});
