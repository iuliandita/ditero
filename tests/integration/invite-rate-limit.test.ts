// Per-user rate limit on /api/invite/create against a real Postgres. M3b routed
// invite creation through a real SMTP send to a caller-supplied address, so an
// unbounded route let one member mail-bomb a third party and spawn unbounded
// invite rows. These exercise the same spend-before-create composition the route
// runs (spendInviteCreateBudget then createInvite then mail), asserting the
// budget bounds both rows and mail. Every fixture uses the fractional 1/60 rate
// on purpose: a `refillPerSec: 0` fixture hid two real M3a bugs in this exact
// token-bucket statement, so it is never used here.
import { eq, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	createInvite,
	INVITE_CREATE_REFILL_PER_SEC,
	spendInviteCreateBudget,
} from "../../src/auth/invite-create.ts";
import * as tables from "../../src/db/schema.ts";
import { takeRateToken } from "../../src/server/notifications/capability.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

const ENV = { DITERO_PUBLIC_URL: "https://todo.example" };

// Distinctive ids so the rate_bucket cleanup (`%irlA`/`%irlB`) and the invite FK
// rows never collide with the neighbouring invite/channel/ack fixtures.
const A = "irlA";
const B = "irlB";

async function seed() {
	await db.insert(tables.user).values([
		{ id: A, name: "A", email: "a@irl.invalid" },
		{ id: B, name: "B", email: "b@irl.invalid" },
	]);
	await db.insert(tables.workspace).values([
		{ id: "wsA", name: "WA", ownerId: A, kind: "shared" },
		{ id: "wsB", name: "WB", ownerId: B, kind: "shared" },
	]);
	await db.insert(tables.membership).values([
		{ id: "mA", userId: A, workspaceId: "wsA", role: "owner" },
		{ id: "mB", userId: B, workspaceId: "wsB", role: "owner" },
	]);
}

async function clean() {
	await db.delete(tables.invite);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.user);
	await db
		.delete(tables.rateBucket)
		.where(like(tables.rateBucket.key, "%irlA"));
	await db
		.delete(tables.rateBucket)
		.where(like(tables.rateBucket.key, "%irlB"));
}

beforeEach(async () => {
	await clean();
	await seed();
});

afterAll(async () => {
	await clean();
	await pool.end();
});

// Mirrors the route: spend the budget, then create the row, then (only on the
// real path) reach the mail send. mail.count standing in for sendInviteMail lets
// a rejected spend prove no mail leg was reached.
async function routeCreate(
	callerId: string,
	workspaceId: string,
	mail: { count: number },
	capacity: number,
) {
	await spendInviteCreateBudget(
		callerId,
		db,
		capacity,
		INVITE_CREATE_REFILL_PER_SEC,
	);
	const result = await createInvite(
		{ workspaceId, role: "member", email: "invitee@example.test" },
		callerId,
		db,
		ENV,
	);
	mail.count += 1;
	return result;
}

describe("invite create rate limit", () => {
	test("the over-budget call 429s and creates no extra row or mail", async () => {
		const capacity = 3;
		const mail = { count: 0 };
		for (let i = 0; i < capacity; i++) {
			await routeCreate(A, "wsA", mail, capacity);
		}
		await expect(routeCreate(A, "wsA", mail, capacity)).rejects.toMatchObject({
			status: 429,
		});
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.createdBy, A));
		expect(rows).toHaveLength(capacity);
		expect(mail.count).toBe(capacity);
	});

	test("the bucket is per user: A exhausting does not block B", async () => {
		const capacity = 2;
		const mail = { count: 0 };
		for (let i = 0; i < capacity; i++)
			await routeCreate(A, "wsA", mail, capacity);
		await expect(routeCreate(A, "wsA", mail, capacity)).rejects.toMatchObject({
			status: 429,
		});

		const forB = await routeCreate(B, "wsB", mail, capacity);
		expect(forB.id).toBeTruthy();
	});

	// Same table, same user id, three namespaces: the `invite-create:` prefix is
	// the only thing keeping an exhausted inviter from spending its channel-test
	// or ack budget. Mirrors the raw-body listener isolation test.
	test("invite-create budget does not drain the channel-test or ack bucket", async () => {
		const capacity = 2;
		const mail = { count: 0 };
		for (let i = 0; i < capacity; i++)
			await routeCreate(A, "wsA", mail, capacity);
		await expect(routeCreate(A, "wsA", mail, capacity)).rejects.toMatchObject({
			status: 429,
		});

		expect(
			await takeRateToken(
				db,
				`channel-test:${A}`,
				5,
				INVITE_CREATE_REFILL_PER_SEC,
			),
		).toBe(true);
		expect(
			await takeRateToken(db, `ack:${A}`, 1, INVITE_CREATE_REFILL_PER_SEC),
		).toBe(true);

		const keys = (
			await db
				.select({ key: tables.rateBucket.key })
				.from(tables.rateBucket)
				.where(like(tables.rateBucket.key, "%irlA"))
		).map((row) => row.key);
		expect(keys.sort()).toEqual([
			`ack:${A}`,
			`channel-test:${A}`,
			`invite-create:${A}`,
		]);
	});

	// The bound-parameter rate must be cast to double precision; the M3a bug
	// inferred integer and aborted on any fractional rate. The production default
	// (1/60) is fractional, so exercising the ON CONFLICT refill branch at it
	// proves the statement does not abort.
	test("runs at the production fractional refill rate without aborting", async () => {
		await expect(spendInviteCreateBudget(A, db)).resolves.toBeUndefined();
		await expect(spendInviteCreateBudget(A, db)).resolves.toBeUndefined();
		await expect(spendInviteCreateBudget(A, db)).resolves.toBeUndefined();
	});
});
