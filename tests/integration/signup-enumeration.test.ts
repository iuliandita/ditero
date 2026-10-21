import { APIError } from "better-auth";
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
		expect(saved.image).toBeNull();
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

async function adversarialSignup(fields: Record<string, unknown>) {
	const started = performance.now();
	const response = await handleAuthRequest(
		new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				origin: "http://localhost:5173",
			},
			body: JSON.stringify({
				name: "Valid",
				email,
				password: "pw-123456",
				...fields,
			}),
		}),
		"198.51.100.85",
	);
	expect(performance.now() - started).toBeGreaterThanOrEqual(
		SIGN_UP_RESPONSE_FLOOR_MS - 10,
	);
	return {
		status: response.status,
		body: await response.text(),
		headers: [...response.headers.entries()],
		cookies: response.headers.getSetCookie(),
	};
}

test.each([
	["NUL avatar", { image: "\u0000" }],
	["overlong avatar", { image: "a".repeat(100_000) }],
	["invalid avatar type", { image: { url: "avatar" } }],
	["NUL name", { name: "Name\u0000" }],
	["overlong name", { name: "a".repeat(81) }],
	["invalid name type", { name: ["Name"] }],
	["blank name fallback", { name: "   " }],
	["unicode name", { name: "  مريم 👩🏽‍💻 e\u0301  " }],
	["unpaired surrogate", { name: "Name\ud800" }],
	["direction control", { name: "Name\u202e" }],
	["NUL password", { password: "password\u0000" }],
	["overlong password", { password: "a".repeat(129) }],
	["invalid password type", { password: ["password"] }],
	["NUL callback", { callbackURL: "/\u0000" }],
	["overlong callback", { callbackURL: `/${"a".repeat(100_000)}` }],
	["invalid callback type", { callbackURL: { url: "/" } }],
	["invalid remember flag", { rememberMe: "yes" }],
	[
		"extra identity fields",
		{
			id: "injected",
			emailVerified: true,
			role: "admin",
			additionalFields: { name: "\u0000" },
		},
	],
	[
		"prototype fields",
		JSON.parse(
			'{"__proto__":{"name":"injected"},"constructor":{"prototype":{"role":"admin"}}}',
		),
	],
] satisfies [
	string,
	Record<string, unknown>,
][])("malformed signup equality: %s", async (_label, fields) => {
	const fresh = await adversarialSignup(fields);
	await cleanup();
	await db
		.insert(tables.user)
		.values({ id: crypto.randomUUID(), name: "Original", email });
	await db.delete(tables.rateLimit);
	const existing = await adversarialSignup(fields);
	expect(existing).toEqual(fresh);
	expect(existing.cookies).toEqual([]);
});

test.each([
	"user",
	"account",
] as const)("%s persistence failure stays neutral and is logged", async (model) => {
	const context = await auth.$context;
	const create = context.adapter.create.bind(context.adapter);
	const failure = new Error(`injected ${model} storage failure`);
	const adapter = vi
		.spyOn(context.adapter, "create")
		.mockImplementation(async (input) => {
			if (input.model === model) throw failure;
			return create(input);
		});
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const authLog = vi.spyOn(context.logger, "error");
	try {
		const failed = await adversarialSignup({});
		expect(failed.status).toBe(200);
		expect(JSON.parse(failed.body)).toEqual({ token: null, user: null });
		expect(failed.cookies).toEqual([]);
		expect(log).toHaveBeenCalledWith(
			"Email sign-up persistence failed",
			expect.anything(),
		);
		expect(authLog.mock.calls.some((args) => args.includes(failure))).toBe(
			true,
		);
		adapter.mockRestore();
		await cleanup();
		await db
			.insert(tables.user)
			.values({ id: crypto.randomUUID(), name: "Original", email });
		expect(await adversarialSignup({})).toEqual(failed);
	} finally {
		adapter.mockRestore();
		log.mockRestore();
		authLog.mockRestore();
	}
});

test("an API creation refusal after admission stays neutral", async () => {
	const failure = new APIError("BAD_REQUEST", {
		message: "injected storage refusal",
	});
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	const context = await auth.$context;
	const create = context.adapter.create.bind(context.adapter);
	const adapter = vi
		.spyOn(context.adapter, "create")
		.mockImplementation(async (input) => {
			if (input.model === "user") throw failure;
			return create(input);
		});
	try {
		const failed = await adversarialSignup({});
		expect(failed.status).toBe(200);
		expect(failed.cookies).toEqual([]);
		expect(log).toHaveBeenCalledWith(
			"Email sign-up persistence failed",
			failure,
		);
		await db
			.insert(tables.user)
			.values({ id: crypto.randomUUID(), name: "Original", email });
		expect(await adversarialSignup({})).toEqual(failed);
	} finally {
		adapter.mockRestore();
		log.mockRestore();
	}
});
