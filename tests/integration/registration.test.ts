import { count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

beforeEach(async () => {
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.user);
});

afterAll(async () => {
	await pool.end();
});

function signup(email: string) {
	return handleAuthRequest(
		new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify({
				name: email.split("@")[0],
				email,
				password: "pw-123456",
			}),
		}),
	);
}

describe("bootstrap registration", () => {
	test("commits exactly one concurrent first signup", async () => {
		const responses = await Promise.all([
			signup("first@test.invalid"),
			signup("second@test.invalid"),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 403,
		]);

		const [result] = await db.select({ value: count() }).from(tables.user);
		expect(result.value).toBe(1);
	});
});
