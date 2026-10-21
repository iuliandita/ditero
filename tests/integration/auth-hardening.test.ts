import { APIError } from "better-auth";
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { auth, handleAuthRequest } from "../../src/auth/auth.ts";
import { withRegistrationBypass } from "../../src/auth/registration-bypass.ts";
import * as tables from "../../src/db/schema.ts";
import { app } from "../../src/server/index.ts";
import { currentTOTP } from "../totp.ts";

// Auth is configured at import time. Even an e2e parent must exercise production
// ceilings here; changing the environment inside a test would be too late.
vi.hoisted(() => {
	delete process.env.DITERO_E2E;
});

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
	await db.delete(tables.managedAccount);
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.passkey);
	await db.delete(tables.twoFactor);
	await db.delete(tables.rateLimit);
	await db
		.delete(tables.rateBucket)
		.where(like(tables.rateBucket.key, "auth:sign-in:%"));
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
		expect(rows[0].count).toBe(6);
		const buckets = await db
			.select()
			.from(tables.rateBucket)
			.where(like(tables.rateBucket.key, "auth:sign-in:%"));
		expect(buckets).toHaveLength(1);
		expect(buckets[0].tokens).toBe(0);
	});

	async function signIn(
		email: string,
		password = "wrong-password",
		suffix = "",
		peerAddress: string | null = "198.51.100.24",
	) {
		return handleAuthRequest(
			new Request(`http://localhost:3000/api/auth/sign-in/email${suffix}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin: "http://localhost:5173",
					"x-ditero-client-ip": "203.0.113.9",
					"x-forwarded-for": "203.0.113.9",
				},
				body: JSON.stringify({ email, password }),
			}),
			peerAddress ?? undefined,
		);
	}

	test("one member's failures do not lock out another and unknown emails have the same limit", async () => {
		await signUp("member-a@test.invalid");
		await withRegistrationBypass(() => signUp("member-b@test.invalid"));
		for (let attempt = 0; attempt < 5; attempt++) {
			expect((await signIn("member-a@test.invalid")).status).toBe(401);
			expect((await signIn("missing@test.invalid")).status).toBe(401);
		}
		const known = await signIn("MEMBER-A@test.invalid", "pw-123456");
		const unknown = await signIn("missing@test.invalid");
		expect(known.status).toBe(429);
		expect(unknown.status).toBe(429);
		expect(await known.json()).toEqual(await unknown.json());
		expect(known.headers.get("retry-after")).toBe(
			unknown.headers.get("retry-after"),
		);
		expect(
			(await signIn("member-a@test.invalid", "pw-123456", "/")).status,
		).toBe(429);
		expect((await signIn("member-b@test.invalid", "pw-123456")).status).toBe(
			200,
		);
	}, 60_000);

	test.each([
		"198.51.100.24",
		null,
	])("the production per-IP ceiling bounds buckets across emails for %s", async (peerAddress) => {
		for (let attempt = 0; attempt < 30; attempt++)
			expect(
				(
					await signIn(
						`missing-${attempt}@test.invalid`,
						"wrong-password",
						"",
						peerAddress,
					)
				).status,
			).toBe(401);
		expect(
			(await signIn("one-more@test.invalid", "wrong-password", "", peerAddress))
				.status,
		).toBe(429);
		for (let attempt = 0; attempt < 40; attempt++)
			expect(
				(
					await signIn(
						`rejected-${attempt}@test.invalid`,
						"wrong-password",
						"",
						peerAddress,
					)
				).status,
			).toBe(429);
		const buckets = await db
			.select()
			.from(tables.rateBucket)
			.where(like(tables.rateBucket.key, "auth:sign-in:%"));
		expect(buckets).toHaveLength(30);
		const rows = await db.select().from(tables.rateLimit);
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(30);
	}, 60_000);

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

describe("display name updates", () => {
	test("normalizes Better Auth updates and refuses invalid names without changing the saved name", async () => {
		const cookie = await signUp("display-name@test.invalid");
		const update = (name: string) =>
			handleAuthRequest(
				new Request("http://localhost:3000/api/auth/update-user", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:5173",
						cookie,
					},
					body: JSON.stringify({ name }),
				}),
			);
		expect((await update("  Maya Chen  ")).status).toBe(200);
		for (const invalid of [
			" ",
			"a".repeat(81),
			"Maya\n",
			"Ma\u0000ya",
			"Ma\u202eya",
		]) {
			const response = await update(invalid);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				code: "INVALID_DISPLAY_NAME",
			});
		}
		const [saved] = await db
			.select()
			.from(tables.user)
			.where(eq(tables.user.email, "display-name@test.invalid"));
		expect(saved.name).toBe("Maya Chen");
	});
});

describe("managed account display names", () => {
	let create: (displayName: string) => Promise<Response>;
	beforeEach(async () => {
		const cookie = await signUp("guardian-name@test.invalid");
		const [guardian] = await db
			.select()
			.from(tables.user)
			.where(eq(tables.user.email, "guardian-name@test.invalid"));
		const workspaceId = crypto.randomUUID();
		await db.insert(tables.workspace).values({
			id: workspaceId,
			name: "Household",
			kind: "shared",
			ownerId: guardian.id,
		});
		await db.insert(tables.membership).values({
			id: crypto.randomUUID(),
			userId: guardian.id,
			workspaceId,
			role: "owner",
		});
		create = (displayName) =>
			app.handle(
				new Request("http://localhost:3000/api/account/managed", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:5173",
						cookie,
					},
					body: JSON.stringify({
						workspaceId,
						displayName,
						password: "kid-password-1",
					}),
				}),
			);
	});

	test("rejects invalid managed names before signup and saves normalized boundary names", async () => {
		const signup = vi.spyOn(auth.api, "signUpEmail");
		try {
			for (const name of [
				"a".repeat(81),
				"a".repeat(100),
				"  ",
				"Maya\n",
				"Ma\u202eya",
			]) {
				const response = await create(name);
				expect(response.status).toBe(400);
				expect(response.headers.get("content-type")).toContain(
					"application/json",
				);
				expect(await response.json()).toEqual({
					message:
						"Use 1-80 characters without control characters for your display name",
				});
				expect(signup).not.toHaveBeenCalled();
			}
		} finally {
			signup.mockRestore();
		}
		expect(await db.select().from(tables.user)).toHaveLength(1);
		expect(await db.select().from(tables.managedAccount)).toEqual([]);
		const name = "a".repeat(80);
		const response = await create(`  ${name}  `);
		expect(response.status).toBe(200);
		const { userId } = (await response.json()) as { userId: string };
		const [saved] = await db
			.select()
			.from(tables.user)
			.where(eq(tables.user.id, userId));
		expect(saved.name).toBe(name);
	});

	test("converts managed signup APIErrors to their JSON status", async () => {
		const signup = vi.spyOn(auth.api, "signUpEmail").mockRejectedValueOnce(
			new APIError("BAD_REQUEST", {
				code: "INVALID_DISPLAY_NAME",
				message: "Invalid display name",
			}),
		);
		try {
			const response = await create("Maya");
			expect(signup).toHaveBeenCalledOnce();
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				code: "INVALID_DISPLAY_NAME",
				message: "Invalid display name",
			});
		} finally {
			signup.mockRestore();
		}
		expect(await db.select().from(tables.managedAccount)).toEqual([]);
	});
});
