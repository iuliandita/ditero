import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, expect, test, vi } from "vitest";
import {
	auth,
	handleAuthRequest,
	SIGN_UP_RESPONSE_FLOOR_MS,
} from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";

const previousMode = vi.hoisted(() => {
	const previous = process.env.DITERO_REGISTRATION_MODE;
	process.env.DITERO_REGISTRATION_MODE = "closed";
	return previous;
});
if (previousMode === undefined) delete process.env.DITERO_REGISTRATION_MODE;
else process.env.DITERO_REGISTRATION_MODE = previousMode;

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const email = "closed-signup@test.invalid";
afterAll(async () => {
	await db.delete(tables.user).where(eq(tables.user.email, email));
	await pool.end();
});

test("closed registration refuses new and existing accounts identically after hashing", async () => {
	await db.delete(tables.rateLimit);
	await db.delete(tables.user).where(eq(tables.user.email, email));
	const context = await auth.$context;
	const hash = vi.spyOn(context.password, "hash");
	try {
		const results = [];
		const durations: number[] = [];
		for (const existing of [false, true]) {
			if (existing)
				await db
					.insert(tables.user)
					.values({ id: crypto.randomUUID(), name: "Closed", email });
			const started = performance.now();
			const response = await handleAuthRequest(
				new Request("http://localhost:3000/api/auth/sign-up/email", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:5173",
					},
					body: JSON.stringify({
						name: "Closed",
						email,
						password: "pw-123456",
					}),
				}),
			);
			durations.push(performance.now() - started);
			results.push({
				status: response.status,
				body: await response.json(),
				cookies: response.headers.getSetCookie(),
			});
		}
		expect(results[1]).toEqual(results[0]);
		expect(results[0]).toMatchObject({
			status: 403,
			body: { code: "REGISTRATION_DISABLED" },
			cookies: [],
		});
		expect(hash).toHaveBeenCalledTimes(2);
		for (const duration of durations)
			expect(duration).toBeGreaterThanOrEqual(SIGN_UP_RESPONSE_FLOOR_MS - 10);
	} finally {
		hash.mockRestore();
	}
});
