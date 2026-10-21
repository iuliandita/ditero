import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, expect, test, vi } from "vitest";
import {
	auth,
	handleAuthRequest,
	SIGN_UP_RESPONSE_FLOOR_MS,
} from "../../src/auth/auth.ts";
import * as tables from "../../src/db/schema.ts";
import { signInForTest } from "../support/auth-sign-in.ts";

const previousMode = vi.hoisted(() => {
	const previous = process.env.DITERO_REGISTRATION_MODE;
	process.env.DITERO_REGISTRATION_MODE = "open";
	return previous;
});
if (previousMode === undefined) delete process.env.DITERO_REGISTRATION_MODE;
else process.env.DITERO_REGISTRATION_MODE = previousMode;

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });
const email = "signup-enumeration@test.invalid";
const durations: number[] = [];

async function cleanup() {
	const [saved] = await db
		.select()
		.from(tables.user)
		.where(eq(tables.user.email, email));
	if (!saved) return;
	await db
		.delete(tables.membership)
		.where(eq(tables.membership.userId, saved.id));
	await db
		.delete(tables.workspace)
		.where(eq(tables.workspace.ownerId, saved.id));
	await db.delete(tables.user).where(eq(tables.user.id, saved.id));
}
beforeEach(async () => {
	durations.length = 0;
	await db.delete(tables.rateLimit);
	await cleanup();
});
afterAll(async () => {
	await cleanup();
	await pool.end();
});

async function signup(name: string, password: string, suffix = "") {
	const started = performance.now();
	const response = await handleAuthRequest(
		new Request(`http://localhost:3000/api/auth/sign-up/email${suffix}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify({
				name,
				email,
				password,
				image: "https://example.com/avatar.png",
			}),
		}),
		"198.51.100.85",
	);
	durations.push(performance.now() - started);
	return {
		status: response.status,
		body: await response.json(),
		cookies: response.headers.getSetCookie(),
	};
}

test("open registration hides duplicate accounts without issuing a session or changing credentials", async () => {
	const context = await auth.$context;
	const hash = vi.spyOn(context.password, "hash");
	const before = await db.select().from(tables.session);
	try {
		const fresh = await signup("  First account  ", "pw-123456");
		const duplicate = await signup(
			"Different name",
			"different-password",
			"?duplicate=1",
		);
		expect(duplicate).toEqual(fresh);
		expect(fresh).toEqual({
			status: 200,
			body: { token: null, user: null },
			cookies: [],
		});
		expect(hash).toHaveBeenCalledTimes(2);
		for (const duration of durations)
			expect(duration).toBeGreaterThanOrEqual(SIGN_UP_RESPONSE_FLOOR_MS - 10);
		expect(await db.select().from(tables.session)).toEqual(before);
		const [saved] = await db
			.select()
			.from(tables.user)
			.where(eq(tables.user.email, email));
		expect(saved.name).toBe("First account");
		const signedIn = await signInForTest(email);
		expect((await signedIn.json()).user.id).toBe(saved.id);
	} finally {
		hash.mockRestore();
	}
});

test("input validation is identical before and after account creation", async () => {
	const malformedBodies = async () => {
		for (const body of [undefined, "null"]) {
			const response = await handleAuthRequest(
				new Request("http://localhost:3000/api/auth/sign-up/email", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "http://localhost:5173",
					},
					body,
				}),
			);
			expect(response.status).toBe(400);
		}
	};
	await malformedBodies();
	const invalid = await signup("Invalid\nname", "pw-123456");
	await signup("Valid", "pw-123456");
	expect(await signup("Invalid\nname", "pw-123456")).toEqual(invalid);
	await malformedBodies();
	expect(invalid).toMatchObject({
		status: 400,
		body: { code: "INVALID_DISPLAY_NAME" },
		cookies: [],
	});
});

test("concurrent signups of the same new email return the neutral response", async () => {
	const context = await auth.$context;
	const find = context.internalAdapter.findUserByEmail.bind(
		context.internalAdapter,
	);
	let arrivals = 0;
	let release!: () => void;
	const barrier = new Promise<void>((resolve) => {
		release = resolve;
	});
	const lookup = vi
		.spyOn(context.internalAdapter, "findUserByEmail")
		.mockImplementation(async (...args) => {
			const result = await find(...args);
			if (!result && arrivals < 2) {
				arrivals += 1;
				if (arrivals === 2) release();
				await barrier;
			}
			return result;
		});
	try {
		const responses = await Promise.all([
			signup("First", "pw-123456"),
			signup("Second", "other-password"),
		]);
		expect(arrivals).toBe(2);
		expect(responses).toEqual([
			{ status: 200, body: { token: null, user: null }, cookies: [] },
			{ status: 200, body: { token: null, user: null }, cookies: [] },
		]);
	} finally {
		lookup.mockRestore();
	}
});
