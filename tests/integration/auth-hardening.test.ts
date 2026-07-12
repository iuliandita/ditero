import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { handleAuthRequest } from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";
import { app } from "../../src/server/index.ts";
import { currentTOTP } from "../totp.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

async function signUp(email: string): Promise<string> {
	const response = await handleAuthRequest(
		new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify({ name: "Security", email, password: "pw-123456" }),
		}),
	);
	expect(response.status).toBe(200);
	return response.headers
		.getSetCookie()
		.map((value) => value.split(";", 1)[0])
		.join("; ");
}

beforeEach(async () => {
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.passkey);
	await db.delete(tables.twoFactor);
	await db.delete(tables.rateLimit);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.user);
});

afterAll(async () => {
	await pool.end();
});

describe("authentication hardening schema", () => {
	test("contains passkey, two-factor, and database rate-limit storage", async () => {
		const result = await pool.query<{ table_name: string }>(
			`select table_name
			 from information_schema.tables
			 where table_schema = 'public'
			   and table_name in ('passkey', 'two_factor', 'rate_limit')`,
		);
		expect(result.rows.map((row) => row.table_name).sort()).toEqual([
			"passkey",
			"rate_limit",
			"two_factor",
		]);

		const userColumns = await pool.query<{ column_name: string }>(
			`select column_name
			 from information_schema.columns
			 where table_schema = 'public' and table_name = 'user'`,
		);
		expect(userColumns.rows.map((row) => row.column_name)).toContain(
			"two_factor_enabled",
		);
	});

	test("rejects cross-origin state changes on auth and application routes", async () => {
		const cookie = await signUp("csrf-integration@test.invalid");
		const headers = {
			"content-type": "application/json",
			cookie,
			origin: "https://evil.test",
		};

		const authResponse = await handleAuthRequest(
			new Request("http://localhost:3000/api/auth/change-password", {
				method: "POST",
				headers,
				body: JSON.stringify({
					currentPassword: "pw-123456",
					newPassword: "pw-654321",
				}),
			}),
		);
		expect(authResponse.status).toBe(403);

		const appResponse = await app.handle(
			new Request("http://localhost:3000/api/bootstrap", {
				method: "POST",
				headers,
				body: "{}",
			}),
		);
		expect(appResponse.status).toBe(403);
	});

	test("persists auth rate limits in PostgreSQL", async () => {
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 6; attempt += 1) {
			const response = await handleAuthRequest(
				new Request("http://localhost:3000/api/auth/sign-in/email", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:5173",
						"x-forwarded-for": "198.51.100.24",
					},
					body: JSON.stringify({
						email: "missing@test.invalid",
						password: "wrong-password",
					}),
				}),
				"198.51.100.24",
			);
			statuses.push(response.status);
		}

		expect(statuses.at(-1)).toBe(429);
		const rows = await db.select().from(tables.rateLimit);
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBeGreaterThanOrEqual(5);
	});

	test("persists TOTP enrollment and requires a second factor at sign-in", async () => {
		const cookies = new Map<string, string>();
		const send = async (path: string, body: Record<string, unknown>) => {
			const cookie = [...cookies.entries()]
				.map(([name, value]) => `${name}=${value}`)
				.join("; ");
			const response = await handleAuthRequest(
				new Request(`http://localhost:3000/api/auth${path}`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:5173",
						...(cookie ? { cookie } : {}),
					},
					body: JSON.stringify(body),
				}),
			);
			const setCookies = response.headers.getSetCookie();
			for (const value of setCookies) {
				const [pair] = value.split(";", 1);
				const separator = pair.indexOf("=");
				cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
			}
			return response;
		};

		expect(
			(
				await send("/sign-up/email", {
					name: "TOTP",
					email: "totp-integration@test.invalid",
					password: "pw-123456",
				})
			).status,
		).toBe(200);

		const enable = await send("/two-factor/enable", {
			password: "pw-123456",
		});
		expect(enable.status).toBe(200);
		const setup = (await enable.json()) as {
			totpURI: string;
			backupCodes: string[];
		};
		const [storedFactor] = await db.select().from(tables.twoFactor);
		expect(storedFactor.secret).toMatch(/^ditero:v1:/);
		expect(storedFactor.backupCodes).toMatch(/^ditero:v1:/);
		const secret = new URL(setup.totpURI).searchParams.get("secret");
		if (!secret) throw new Error("missing TOTP secret");
		const verify = await send("/two-factor/verify-totp", {
			code: currentTOTP(secret),
		});
		expect(verify.status, await verify.clone().text()).toBe(200);
		const [savedUser] = await db
			.select()
			.from(tables.user)
			.where(eq(tables.user.email, "totp-integration@test.invalid"));
		expect(savedUser.twoFactorEnabled).toBe(true);

		await send("/sign-out", {});
		cookies.clear();
		const signIn = await send("/sign-in/email", {
			email: "totp-integration@test.invalid",
			password: "pw-123456",
		});
		expect(signIn.status).toBe(200);
		expect(await signIn.json()).toMatchObject({
			twoFactorRedirect: true,
			twoFactorMethods: ["totp"],
		});
	});
});
