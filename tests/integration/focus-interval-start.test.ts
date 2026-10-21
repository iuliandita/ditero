// focus.startInterval / focus.logSession on the real server path: the runtime
// role is NOBYPASSRLS and every mutation runs inside withZeroUserContext, as the
// mutate route does. Backdating goes through the admin pool.
import { randomBytes, randomUUID } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import {
	FocusEarlyError,
	focusEarlyWaitMs,
	isFocusDuplicate,
} from "../../src/domain/focus-interval.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { queries } from "../../src/zero/queries.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: url });
const role = `focus_start_${randomBytes(8).toString("hex")}`;
const pool = new Pool({
	connectionString: url,
	options: `-c role=${role}`,
	max: 4,
});
const zdb = zeroNodePg(schema, pool);
const A = "fi-a";
const B = "fi-b";
const ANCHOR = Date.UTC(2026, 0, 1);

async function asServer<Args>(
	userId: string,
	mutator: {
		fn: (a: { tx: never; ctx: { id: string }; args: Args }) => Promise<void>;
	},
	args: Args,
) {
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, userId, () =>
			mutator.fn({ tx: tx as never, ctx: { id: userId }, args }),
		),
	);
}
const start = (userId: string, intervalId: string) =>
	asServer(userId, mutators.focus.startInterval, { intervalId });
const log = (
	userId: string,
	intervalId: string,
	durationSec = 1500,
	pausedMs?: number,
) =>
	asServer(userId, mutators.focus.logSession, {
		intervalId,
		kind: "work" as const,
		startedAt: ANCHOR,
		endedAt: ANCHOR + durationSec * 1000,
		durationSec,
		...(pausedMs === undefined ? {} : { pausedMs }),
	});
const backdate = (userId: string, intervalId: string, ms: number) =>
	admin.query(
		`update focus_interval_start set started_at = now() - make_interval(secs => $3 / 1000.0)
		 where user_id = $1 and interval_id = $2`,
		[userId, intervalId, ms],
	);
const sessions = async (userId: string) =>
	(
		await admin.query("select id from focus_session where user_id = $1", [
			userId,
		])
	).rows;

beforeAll(async () => {
	await admin.query(
		`create role "${role}" nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	// The runtime role's DML grants (docs/runbooks/database-roles.md); only RLS
	// separates one user's rows from another's.
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	for (const id of [A, B])
		await admin.query(
			`insert into "user"(id,name,email,email_verified) values($1,'Focus fixture',$2,true)
			 on conflict do nothing`,
			[id, `${id}@example.test`],
		);
});
beforeEach(async () => {
	await admin.query("delete from focus_session where user_id = any($1)", [
		[A, B],
	]);
	await admin.query(
		"delete from focus_interval_start where user_id = any($1)",
		[[A, B]],
	);
});
afterAll(async () => {
	await admin.query("delete from focus_session where user_id = any($1)", [
		[A, B],
	]);
	await admin.query('delete from "user" where id = any($1)', [[A, B]]);
	await pool.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});

describe("focus interval start on the server path", () => {
	test("the synced query returns only the caller's recorded starts", async () => {
		const own = randomUUID();
		const other = randomUUID();
		await start(A, own);
		await start(B, other);
		// Query authorization must hold independently of database RLS: Zero
		// evaluates the query against its shared replica.
		const replica = zeroNodePg(schema, admin);
		for (const [id, intervalId] of [
			[A, own],
			[B, other],
		]) {
			expect(
				await replica.run(
					queries.focusIntervalStarts.mine.fn({ args: undefined, ctx: { id } }),
				),
			).toEqual([{ userId: id, intervalId }]);
		}
	});

	test("the start time is the server's, never a client value", async () => {
		const id = randomUUID();
		await asServer(A, mutators.focus.startInterval, {
			intervalId: id,
			startedAt: 1,
		} as never);
		const { rows } = await admin.query(
			"select extract(epoch from now() - started_at) as age from focus_interval_start where user_id=$1 and interval_id=$2",
			[A, id],
		);
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].age)).toBeLessThan(30);
		await backdate(A, id, 600_000);
		await start(A, id);
		const again = await admin.query(
			"select extract(epoch from now() - started_at) as age from focus_interval_start where user_id=$1 and interval_id=$2",
			[A, id],
		);
		expect(Number(again.rows[0].age)).toBeGreaterThan(500);
	});

	test("an early completion is rejected as retryable and records nothing", async () => {
		const id = randomUUID();
		await start(A, id);
		await backdate(A, id, 5_000);
		const failure = await log(A, id, 60).catch((e: unknown) => e);
		expect(failure).toBeInstanceOf(FocusEarlyError);
		const wait = focusEarlyWaitMs(failure);
		expect(wait).toBeGreaterThan(40_000);
		expect(wait).toBeLessThanOrEqual(50_000);
		expect(await sessions(A)).toEqual([]);
	});

	test("the retry is credited once enough server time has passed", async () => {
		const id = randomUUID();
		await start(A, id);
		await backdate(A, id, 5_000);
		await expect(log(A, id, 60)).rejects.toBeInstanceOf(FocusEarlyError);
		await backdate(A, id, 61_000);
		await log(A, id, 60);
		expect(await sessions(A)).toEqual([{ id: `${A}:${id}` }]);
	});

	test("network latency within the allowance does not count as early", async () => {
		const near = randomUUID();
		await start(A, near);
		await backdate(A, near, 57_000);
		await log(A, near, 60);
		const short = randomUUID();
		await start(A, short);
		await backdate(A, short, 53_000);
		await expect(log(A, short, 60)).rejects.toBeInstanceOf(FocusEarlyError);
		expect(await sessions(A)).toEqual([{ id: `${A}:${near}` }]);
	});

	test("a reported pause raises the required server time", async () => {
		const id = randomUUID();
		await start(A, id);
		await backdate(A, id, 70_000);
		await expect(log(A, id, 60, 30_000)).rejects.toBeInstanceOf(
			FocusEarlyError,
		);
		await log(A, id, 60, 5_000);
		expect(await sessions(A)).toHaveLength(1);
	});

	test("a duplicate is ignored even after the start row is gone", async () => {
		const id = randomUUID();
		await start(A, id);
		await backdate(A, id, 61_000);
		// Two tabs logging at once: the loser may fail, but only on the session's
		// primary key, which the client treats as already recorded.
		const raced = await Promise.allSettled([log(A, id, 60), log(A, id, 60)]);
		expect(raced.some((r) => r.status === "fulfilled")).toBe(true);
		for (const r of raced)
			if (r.status === "rejected")
				expect(isFocusDuplicate(r.reason)).toBe(true);
		await log(A, id, 60);
		await admin.query("delete from focus_interval_start where user_id=$1", [A]);
		await log(A, id, 60);
		expect(await sessions(A)).toHaveLength(1);
		const karma = await admin.query(
			"select (select count(*) from karma where user_id=$1) + (select count(*) from karma_event where user_id=$1) as n",
			[A],
		);
		expect(Number(karma.rows[0].n)).toBe(0);
	});

	test("the duplicate-key failure of a lost race is recognized from the real message", async () => {
		const id = randomUUID();
		await log(A, id, 60);
		const row = (
			await admin.query("select * from focus_session where user_id=$1", [A])
		).rows[0];
		const failure = await admin
			.query(
				`insert into focus_session (id, user_id, kind, started_at, ended_at, duration_sec)
				 values ($1, $2, 'work', now(), now(), 60)`,
				[row.id, A],
			)
			.then(
				() => null,
				(e: unknown) => e,
			);
		expect(failure).toBeInstanceOf(Error);
		expect(failure).toMatchObject({
			code: "23505",
			constraint: "focus_session_pkey",
		});
		expect(isFocusDuplicate(failure)).toBe(true);
		expect(isFocusDuplicate(new FocusEarlyError(1000))).toBe(false);
		expect(isFocusDuplicate(new Error("relation does not exist"))).toBe(false);
	});

	test("without a recorded start the client-side gate is the only check", async () => {
		await log(A, randomUUID(), 60);
		expect(await sessions(A)).toHaveLength(1);
	});

	test("another account's interval can be neither read nor written", async () => {
		const id = randomUUID();
		const own = randomUUID();
		await start(A, id);
		await start(B, own);
		const asB = async (sql: string, params: unknown[] = []) => {
			const client = await pool.connect();
			try {
				await client.query("begin");
				await client.query("select set_config('ditero.user_id', $1, true)", [
					B,
				]);
				return await client.query(sql, params);
			} finally {
				await client.query("rollback");
				client.release();
			}
		};
		expect(
			(await asB("select interval_id from focus_interval_start")).rows,
		).toEqual([{ interval_id: own }]);
		expect(
			(
				await asB("select * from focus_interval_start where interval_id=$1", [
					id,
				])
			).rows,
		).toEqual([]);
		expect(
			(
				await asB(
					"update focus_interval_start set started_at = now() where user_id = $1",
					[B],
				)
			).rowCount,
		).toBe(0);
		expect(
			(
				await asB(
					"update focus_interval_start set started_at = now() where user_id = $1",
					[A],
				)
			).rowCount,
		).toBe(0);
		expect(
			(await asB("delete from focus_interval_start where user_id = $1", [A]))
				.rowCount,
		).toBe(0);
		await expect(
			asB(
				"insert into focus_interval_start(user_id, interval_id) values ($1, $2)",
				[A, randomUUID()],
			),
		).rejects.toThrow(/row-level security/);
		// B reusing A's interval id gets an independent row and clock.
		await backdate(A, id, 600_000);
		await start(B, id);
		const { rows } = await admin.query(
			"select user_id, extract(epoch from now() - started_at) as age from focus_interval_start where interval_id=$1 order by user_id",
			[id],
		);
		expect(rows.map((r) => r.user_id)).toEqual([A, B]);
		expect(Number(rows[0].age)).toBeGreaterThan(500);
		expect(Number(rows[1].age)).toBeLessThan(30);
		await expect(log(B, id, 60)).rejects.toBeInstanceOf(FocusEarlyError);
		await log(A, id, 60);
		expect(await sessions(A)).toHaveLength(1);
		expect(await sessions(B)).toEqual([]);
	});

	test("a start prunes the caller's rows older than 14 days", async () => {
		const old = randomUUID();
		await start(A, old);
		await backdate(A, old, 15 * 86_400_000);
		await start(A, randomUUID());
		const { rows } = await admin.query(
			"select interval_id from focus_interval_start where user_id=$1",
			[A],
		);
		expect(rows.map((r) => r.interval_id)).not.toContain(old);
	});
});
