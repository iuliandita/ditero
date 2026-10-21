import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
	auth,
	handleAuthRequest,
	SIGN_UP_RESPONSE_FLOOR_MS,
} from "../../src/auth/auth.ts";
import { acceptInvite } from "../../src/auth/invite-accept.ts";
import { emailHasRedeemableInvite } from "../../src/auth/invite-bypass.ts";
import { assertRegistrationAllowed } from "../../src/auth/registration.ts";
import * as tables from "../../src/db/schema.ts";
import { signInForTest } from "../support/auth-sign-in.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

beforeEach(async () => {
	await db.delete(tables.comment);
	await db.delete(tables.taskAssignee);
	await db.delete(tables.invite);
	await db.delete(tables.managedAccount);
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.session);
	await db.delete(tables.account);
	await db.delete(tables.user);
	// Reset the DB-backed auth rate limiter so per-test signup counts don't bleed
	// across cases (signup is capped at 5/60s per IP; this file makes more).
	await db.delete(tables.rateLimit);
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

// Seed a workspace + its owner directly so we can attach real invites. Returns
// nothing; callers seed invites referencing "seed-ws"/"seed-owner".
async function seedWorkspaceOwner() {
	await db.insert(tables.user).values({
		id: "seed-owner",
		name: "owner",
		email: "owner@test.invalid",
	});
	await db.insert(tables.workspace).values({
		id: "seed-ws",
		name: "Seed",
		ownerId: "seed-owner",
		kind: "shared",
	});
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
		const [created] = await db.select().from(tables.user);
		const session = await signInForTest(created.email);
		expect(session.headers.getSetCookie().length).toBeGreaterThan(0);
		expect(await db.select().from(tables.membership)).toMatchObject([
			{ userId: created.id, role: "owner" },
		]);
	});
});

// Once the first user exists, bootstrap denies uninvited signups exactly like a
// closed instance -- this is the invite gate the bypass must (only) widen.
describe("invite-gated registration (post-first-user)", () => {
	test("uninvited signup is rejected", async () => {
		await seedWorkspaceOwner();
		const response = await signup("stranger@test.invalid");
		expect(response.status).toBe(403);
		const [result] = await db.select({ value: count() }).from(tables.user);
		expect(result.value).toBe(1); // only the seeded owner
	});

	test("signup with a pending email invite succeeds", async () => {
		await seedWorkspaceOwner();
		await db.insert(tables.invite).values({
			id: "invite-email",
			workspaceId: "seed-ws",
			role: "member",
			email: "invited@test.invalid",
			token: "token-email",
			status: "pending",
			createdBy: "seed-owner",
		});

		const response = await signup("invited@test.invalid");
		expect(response.status).toBe(200);

		const created = await db
			.select({ id: tables.user.id })
			.from(tables.user)
			.where(eq(tables.user.email, "invited@test.invalid"));
		expect(created).toHaveLength(1);
		expect(response.headers.getSetCookie()).toEqual([]);
		const signedIn = await signInForTest("invited@test.invalid");
		expect(signedIn.headers.getSetCookie().length).toBeGreaterThan(0);
		await acceptInvite(
			"token-email",
			created[0].id,
			"invited@test.invalid",
			db,
		);
		expect(
			await db
				.select()
				.from(tables.membership)
				.where(eq(tables.membership.workspaceId, "seed-ws")),
		).toMatchObject([{ userId: created[0].id, role: "member" }]);
	});

	test("an open (email-null) invite does NOT enable signup", async () => {
		await seedWorkspaceOwner();
		// Unbounded link/code invite: email null, no expiry, unlimited uses.
		await db.insert(tables.invite).values({
			id: "invite-link",
			workspaceId: "seed-ws",
			role: "member",
			email: null,
			token: "token-link",
			status: "pending",
			maxUses: null,
			createdBy: "seed-owner",
		});

		const response = await signup("random@test.invalid");
		expect(response.status).toBe(403);
		const [result] = await db.select({ value: count() }).from(tables.user);
		expect(result.value).toBe(1); // seeded owner only; no account minted
	});
});

// Seam-level checks for the literal closed mode (the integration harness pins the
// module registration mode to bootstrap, so exercise the decision directly).
describe("closed-mode invite bypass at the seam", () => {
	test("closed + real pending email invite => allowed", async () => {
		await seedWorkspaceOwner();
		await db.insert(tables.invite).values({
			id: "invite-seam",
			workspaceId: "seed-ws",
			role: "member",
			email: "seam@test.invalid",
			token: "token-seam",
			status: "pending",
			createdBy: "seed-owner",
		});

		const invited = await emailHasRedeemableInvite(
			"seam@test.invalid",
			db,
			Date.now(),
		);
		expect(invited).toBe(true);
		expect(() =>
			assertRegistrationAllowed("closed", 5, { invited }),
		).not.toThrow();
	});

	test("closed + open (email-null) invite => denied for arbitrary email", async () => {
		await seedWorkspaceOwner();
		await db.insert(tables.invite).values({
			id: "invite-seam-link",
			workspaceId: "seed-ws",
			role: "member",
			email: null,
			token: "token-seam-link",
			status: "pending",
			maxUses: null,
			createdBy: "seed-owner",
		});

		const invited = await emailHasRedeemableInvite(
			"whoever@test.invalid",
			db,
			Date.now(),
		);
		expect(invited).toBe(false);
		expect(() => assertRegistrationAllowed("closed", 5, { invited })).toThrow(
			/registration is disabled/i,
		);
	});

	test("closed + no invite => denied", async () => {
		await seedWorkspaceOwner();
		const invited = await emailHasRedeemableInvite(
			"nobody@test.invalid",
			db,
			Date.now(),
		);
		expect(invited).toBe(false);
		expect(() => assertRegistrationAllowed("closed", 5, { invited })).toThrow(
			/registration is disabled/i,
		);
	});
});

test("bootstrap policy refuses existing and unknown emails identically after hashing", async () => {
	await seedWorkspaceOwner();
	const context = await auth.$context;
	const hash = vi.spyOn(context.password, "hash");
	try {
		const results = [];
		const durations: number[] = [];
		for (const email of ["owner@test.invalid", "missing@test.invalid"]) {
			const start = performance.now();
			const response = await signup(email);
			durations.push(performance.now() - start);
			results.push({
				status: response.status,
				body: await response.json(),
				cookies: response.headers.getSetCookie(),
			});
		}
		expect(hash).toHaveBeenCalledTimes(2);
		expect(results[0]).toEqual(results[1]);
		expect(results[0]).toMatchObject({
			status: 403,
			body: { code: "REGISTRATION_INVITE_REQUIRED" },
			cookies: [],
		});
		for (const duration of durations)
			expect(duration).toBeGreaterThanOrEqual(SIGN_UP_RESPONSE_FLOOR_MS - 10);
	} finally {
		hash.mockRestore();
	}
});
