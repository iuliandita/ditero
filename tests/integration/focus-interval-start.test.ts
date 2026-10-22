// focus.startInterval / focus.logSession on the real server path: the runtime
// role is NOBYPASSRLS and every mutation runs inside withZeroUserContext, as the
// mutate route does. Backdating goes through the admin pool.
import { spawnSync } from "node:child_process";
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
import { pruneFocusIntervals } from "../../src/server/notifications/scheduler.ts";
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
		`update server_private.focus_interval_clock set started_at = now() - make_interval(secs => $3 / 1000.0)
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
	await admin.query(
		`grant usage on schema public, server_private to "${role}"`,
	);
	// The runtime role's DML grants (docs/runbooks/database-roles.md); only RLS
	// separates one user's rows from another's.
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	await admin.query(
		`grant select,insert,update on server_private.focus_interval_clock to "${role}"`,
	);
	for (const id of [A, B])
		await admin.query(
			`insert into "user"(id,name,email,email_verified) values($1,'Focus fixture',$2,true)
			 on conflict do nothing`,
			[id, `${id}@example.test`],
		);
});
beforeEach(async () => {
	await admin.query(
		"delete from server_private.focus_interval_clock where user_id = any($1)",
		[[A, B]],
	);
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
			"select extract(epoch from now() - started_at) as age from server_private.focus_interval_clock where user_id=$1 and interval_id=$2",
			[A, id],
		);
		expect(rows).toHaveLength(1);
		expect(Number(rows[0].age)).toBeLessThan(30);
		await backdate(A, id, 600_000);
		await start(A, id);
		const again = await admin.query(
			"select extract(epoch from now() - started_at) as age from server_private.focus_interval_clock where user_id=$1 and interval_id=$2",
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
		expect(wait).toBeGreaterThan(50_000);
		expect(wait).toBeLessThanOrEqual(60_000);
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

	test("credit requires the full duration without a per-interval allowance", async () => {
		const near = randomUUID();
		await start(A, near);
		await backdate(A, near, 61_000);
		await log(A, near, 60);
		const short = randomUUID();
		await start(A, short);
		await backdate(A, short, 57_000);
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
		await start(A, id);
		await backdate(A, id, 61_000);
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

	test("missing server evidence cannot use the offline fallback", async () => {
		await expect(log(A, randomUUID(), 60)).rejects.toThrow("focus-unverified");
		expect(await sessions(A)).toHaveLength(0);
		await asServer(A, mutators.focus.logSession, {
			intervalId: randomUUID(),
			proof: "monotonic",
			kind: "work",
			startedAt: ANCHOR,
			endedAt: ANCHOR + 60_000,
			durationSec: 60,
		});
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
					"update focus_interval_start set interval_id = interval_id where user_id = $1",
					[B],
				)
			).rowCount,
		).toBe(0);
		expect(
			(
				await asB(
					"update focus_interval_start set interval_id = interval_id where user_id = $1",
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
		expect(
			(await asB("select interval_id from server_private.focus_interval_clock"))
				.rows,
		).toEqual([{ interval_id: own }]);
		expect(
			(
				await asB(
					"update server_private.focus_interval_clock set closed_at=now() where user_id=$1",
					[A],
				)
			).rowCount,
		).toBe(0);
		await expect(
			asB(
				"insert into server_private.focus_interval_clock(user_id,interval_id) values ($1,$2)",
				[A, randomUUID()],
			),
		).rejects.toThrow(/row-level security/);
		expect(
			(
				await pool.query(
					"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
				)
			).rows,
		).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		// B reusing A's interval id gets an independent row and clock.
		await backdate(A, id, 600_000);
		await start(B, id);
		const { rows } = await admin.query(
			"select user_id, extract(epoch from now() - started_at) as age from server_private.focus_interval_clock where interval_id=$1 order by user_id",
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

	test("the scheduler prunes dormant owners in bounded batches", async () => {
		await admin.query(
			`insert into server_private.focus_interval_clock(user_id,interval_id,started_at)
			select $1, gen_random_uuid(), now() - interval '15 days' from generate_series(1,502)`,
			[A],
		);
		await admin.query(
			"insert into focus_interval_start(user_id,interval_id) select user_id,interval_id from server_private.focus_interval_clock where user_id=$1",
			[A],
		);
		await start(B, randomUUID());
		await pruneFocusIntervals(pool);
		const count = async () =>
			(
				await admin.query(
					"select count(*)::int as n from focus_interval_start where user_id=$1",
					[A],
				)
			).rows[0].n;
		expect(await count()).toBe(2);
		await pruneFocusIntervals(pool);
		expect(await count()).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int as n from server_private.focus_interval_clock where user_id=$1",
					[A],
				)
			).rows[0].n,
		).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int as n from focus_interval_start where user_id=$1",
					[B],
				)
			).rows[0].n,
		).toBe(1);
	});
	test("three forward-reload 60-second intervals cannot multiply server time", async () => {
		const began = Number(
			(
				await admin.query(
					"select extract(epoch from clock_timestamp())::float8 as seconds",
				)
			).rows[0].seconds,
		);
		const ids = [randomUUID(), randomUUID(), randomUUID()];
		for (const id of ids) await start(A, id);
		await new Promise((resolve) => setTimeout(resolve, 60_100));
		for (const id of ids)
			await log(A, id, 60).catch((error: unknown) => {
				expect(String(error)).toMatch(/focus-unverified|focus-early/);
			});
		const { rows } = await admin.query(
			"select coalesce(sum(duration_sec),0)::int as seconds from focus_session where user_id=$1",
			[A],
		);
		expect(rows[0].seconds).toBeLessThanOrEqual(
			Number(
				(
					await admin.query(
						"select extract(epoch from clock_timestamp())::float8 as seconds",
					)
				).rows[0].seconds,
			) - began,
		);
		expect(rows[0].seconds).toBe(60);
	}, 90_000);

	test("restoring away a previously acknowledged start rejects its pending completion", async () => {
		const id = randomUUID();
		await start(A, id);
		await admin.query(
			"delete from server_private.focus_interval_clock where user_id=$1",
			[A],
		);
		await expect(log(A, id, 60)).rejects.toThrow("focus-unverified");
		expect(await sessions(A)).toHaveLength(0);
	});
});

test("the real Zero hydrate and wire serializer emit only acknowledgement ids", async () => {
	const id = randomUUID();
	await start(A, id);
	const { rows } = await admin.query(
		"select * from focus_interval_start where user_id=$1 and interval_id=$2",
		[A, id],
	);
	expect(rows).toHaveLength(1);
	const wire = spawnSync(process.execPath, ["tests/support/focus-wire.mjs"], {
		input: JSON.stringify(rows[0]),
		encoding: "utf8",
	});
	expect(wire.status, wire.stderr).toBe(0);
	expect(JSON.parse(wire.stdout)).toEqual({ user_id: A, interval_id: id });
});

test("private clock runtime grants and ownership checks hold under NOBYPASSRLS", async () => {
	const a = randomUUID(),
		b = randomUUID();
	await start(A, a);
	await start(B, b);
	const client = await pool.connect();
	try {
		await client.query("begin");
		expect(
			(
				await client.query(
					"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
				)
			).rows,
		).toEqual([{ rolsuper: false, rolbypassrls: false }]);
		expect(
			(
				await client.query(
					"select interval_id from server_private.focus_interval_clock",
				)
			).rows,
		).toEqual([]);
		await client.query("select set_config('ditero.user_id',$1,true)", [B]);
		expect(
			(
				await client.query(
					"select interval_id from server_private.focus_interval_clock",
				)
			).rows,
		).toEqual([{ interval_id: b }]);
		expect(
			(
				await client.query(
					"update server_private.focus_interval_clock set closed_at=clock_timestamp() where user_id=$1",
					[A],
				)
			).rowCount,
		).toBe(0);
		expect(
			(
				await client.query(
					"update server_private.focus_interval_clock set closed_at=clock_timestamp() where user_id=$1",
					[B],
				)
			).rowCount,
		).toBe(1);
		await client.query("savepoint owner_check");
		await expect(
			client.query(
				"update server_private.focus_interval_clock set user_id=$1 where user_id=$2",
				[A, B],
			),
		).rejects.toThrow(/row-level security/);
		await client.query("rollback to owner_check");
		const privileges = await client.query(`select
   has_table_privilege('server_private.focus_interval_clock','SELECT') as sel,
   has_table_privilege('server_private.focus_interval_clock','INSERT') as ins,
   has_table_privilege('server_private.focus_interval_clock','UPDATE') as upd,
   has_table_privilege('server_private.focus_interval_clock','DELETE') as del,
   has_schema_privilege('server_private','CREATE') as ddl`);
		expect(privileges.rows).toEqual([
			{ sel: true, ins: true, upd: true, del: false, ddl: false },
		]);
	} finally {
		await client.query("rollback");
		client.release();
	}
});
