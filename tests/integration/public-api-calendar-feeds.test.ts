import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { makeGuards } from "../../src/server/guards.ts";
import {
	createCalendarFeed,
	downloadCalendarFeed,
	listCalendarFeeds,
	revokeCalendarFeed,
} from "../../src/server/public-api/calendar-feeds.ts";
import {
	calendarFeedRoutes,
	publicApiRoutes,
} from "../../src/server/public-api/routes.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `feed_${randomUUID().replaceAll("-", "")}`;
const role = `${prefix}_runtime`;
const password = randomBytes(32).toString("hex");
const connection = new URL(databaseURL);
connection.username = role;
connection.password = password;
const runtime = new Pool({
	connectionString: connection.toString(),
	application_name: role,
});
const owner = `${prefix}_owner`,
	viewer = `${prefix}_viewer`,
	other = `${prefix}_other`;
const workspace = `${prefix}_workspace`,
	list = `${prefix}_list`,
	empty = `${prefix}_empty`;
const app = publicApiRoutes(runtime, async () => true);
const create = (listId = list) =>
	createCalendarFeed(runtime, viewer, { name: "Shared calendar", listId });
async function boundedCleanup(pending: Promise<unknown>, phase: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			pending,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Calendar feed cleanup ${phase} timed out`)),
					2000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
async function withFixtureClient(
	client: PoolClient,
	run: () => Promise<void>,
	pending: () => Promise<unknown> | undefined = () => undefined,
) {
	let failed = false;
	let firstCause: unknown;
	const cleanupErrors: unknown[] = [];
	const phase = async (name: string, action: () => unknown) => {
		try {
			await action();
		} catch (error) {
			if (!failed) {
				failed = true;
				firstCause = error;
			}
			cleanupErrors.push(
				new Error(`Calendar feed cleanup ${name} failed`, { cause: error }),
			);
		}
	};
	try {
		await run();
	} catch (error) {
		failed = true;
		firstCause = error;
	}
	let destroy = false;
	try {
		await phase("rollback", async () => {
			try {
				await boundedCleanup(client.query("rollback"), "rollback");
			} catch (error) {
				destroy = true;
				throw error;
			}
		});
	} finally {
		await phase("release", () => client.release(destroy));
	}
	await phase("pending", async () => {
		const request = pending();
		if (request) await boundedCleanup(request, "pending");
	});
	if (cleanupErrors.length)
		throw new AggregateError(
			[firstCause, ...cleanupErrors],
			"Calendar feed fixture cleanup failed",
			{ cause: firstCause },
		);
	if (failed) throw firstCause;
}
beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(
		`grant connect on database "${decodeURIComponent(connection.pathname.slice(1)).replaceAll('"', '""')}" to "${role}"`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on "user",workspace,membership,list,task,user_pref,calendar_feed to "${role}"`,
	);
	await admin.query(
		"insert into \"user\"(id,name,email,email_verified) values($1,'Owner',$4,true),($2,'Viewer',$5,true),($3,'Other',$6,true)",
		[
			owner,
			viewer,
			other,
			`${owner}@example.test`,
			`${viewer}@example.test`,
			`${other}@example.test`,
		],
	);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Shared',$2,'shared')",
		[workspace, owner],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner'),($4,$5,$3,'viewer')",
		[`${prefix}_owner_seat`, owner, workspace, `${prefix}_viewer_seat`, viewer],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$3,$4,'Tasks','a0'),($2,$3,$4,'Empty','a1')",
		[list, empty, workspace, owner],
	);
	await admin.query(
		"insert into task(id,list_id,title,notes,sort_key) values($1,$2,'Task, ☕','Line one'||chr(10)||'Line two','a0')",
		[`${prefix}_task`, list],
	);
});
afterEach(async () => {
	await admin.query("delete from calendar_feed where user_id=any($1::text[])", [
		[owner, viewer, other],
	]);
});
afterAll(async () => {
	let firstCause: unknown;
	const failures: string[] = [];
	const phase = async (name: string, run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			if (!failures.length) firstCause = error;
			failures.push(name);
		}
	};
	await phase("runtime-pool", () => runtime.end());
	await phase("ownership", async () => {
		const lists = await admin.query(
			"select id from list where id=any($1::text[]) and (workspace_id<>$2 or owner_id<>$3)",
			[[list, empty], workspace, owner],
		);
		expect(lists.rowCount).toBe(0);
		const spaces = await admin.query(
			"select id from workspace where id=$1 and owner_id<>$2",
			[workspace, owner],
		);
		expect(spaces.rowCount).toBe(0);
	});
	await phase("tasks", () =>
		admin.query(
			"delete from task where list_id in (select id from list where id=any($1::text[]) and workspace_id=$2 and owner_id=$3)",
			[[list, empty], workspace, owner],
		),
	);
	await phase("feeds", () =>
		admin.query("delete from calendar_feed where user_id=any($1::text[])", [
			[owner, viewer, other],
		]),
	);
	await phase("lists", () =>
		admin.query(
			"delete from list where id=any($1::text[]) and workspace_id=$2 and owner_id=$3",
			[[list, empty], workspace, owner],
		),
	);
	await phase("memberships", () =>
		admin.query(
			"delete from membership where workspace_id in(select id from workspace where id=$1 and owner_id=$2)",
			[workspace, owner],
		),
	);
	await phase("workspace", () =>
		admin.query("delete from workspace where id=$1 and owner_id=$2", [
			workspace,
			owner,
		]),
	);
	await phase("users", () =>
		admin.query(
			'delete from "user" where id=any($1::text[]) and email=any($2::text[])',
			[
				[owner, viewer, other],
				[
					`${owner}@example.test`,
					`${viewer}@example.test`,
					`${other}@example.test`,
				],
			],
		),
	);
	await phase("row-residuals", async () => {
		const rows = await admin.query(
			`select (select count(*) from "user" where id=any($1::text[]))+(select count(*) from workspace where id=$2)+(select count(*) from list where id=any($3::text[]))+(select count(*) from membership where user_id=any($1::text[]) or workspace_id=$2)+(select count(*) from calendar_feed where user_id=any($1::text[]))+(select count(*) from task where list_id=any($3::text[])) as count`,
			[[owner, viewer, other], workspace, [list, empty]],
		);
		expect(Number(rows.rows[0].count)).toBe(0);
	});
	await phase("role-objects", async () => {
		if (
			(await admin.query("select 1 from pg_roles where rolname=$1", [role]))
				.rowCount
		)
			await admin.query(`drop owned by "${role}"`);
	});
	await phase("role", async () => {
		if (
			(await admin.query("select 1 from pg_roles where rolname=$1", [role]))
				.rowCount
		)
			await admin.query(`drop role "${role}"`);
	});
	await phase("role-session-residuals", async () => {
		expect(
			(
				await admin.query(
					"select count(*)::integer count from pg_stat_activity where application_name=$1",
					[role],
				)
			).rows[0].count,
		).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::integer count from pg_roles where rolname=$1",
					[role],
				)
			).rows[0].count,
		).toBe(0);
	});
	await phase("admin-pool", () => admin.end());
	if (failures.length)
		console.error("calendar feed cleanup failed phases:", failures.join(","));
	if (failures.length) throw firstCause;
});

test("real LOGIN role and FORCE RLS protect capability metadata", async () => {
	expect(
		(
			await runtime.query(
				"select current_user,session_user,rolsuper,rolbypassrls,rolcanlogin,rolinherit from pg_roles where rolname=current_user",
			)
		).rows[0],
	).toEqual({
		current_user: role,
		session_user: role,
		rolsuper: false,
		rolbypassrls: false,
		rolcanlogin: true,
		rolinherit: false,
	});
	expect(
		(
			await runtime.query(
				"select pg_get_userbyid(relowner)=current_user as owner from pg_class where oid='calendar_feed'::regclass",
			)
		).rows[0].owner,
	).toBe(false);
	expect(
		(
			await admin.query(
				"select relrowsecurity,relforcerowsecurity from pg_class where oid='calendar_feed'::regclass",
			)
		).rows[0],
	).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
	const feed = await create();
	expect((await runtime.query("select id from calendar_feed")).rowCount).toBe(
		0,
	);
	expect(await listCalendarFeeds(runtime, other)).toEqual([]);
	const metadata = await listCalendarFeeds(runtime, viewer);
	expect(metadata).toHaveLength(1);
	expect(metadata[0].id).toBe(feed.id);
	expect(JSON.stringify(metadata).includes(feed.secret)).toBe(false);
	expect(metadata[0]).not.toHaveProperty("secretHash");
});
test("Viewer fixed-list feed is independent of PAT and preserves calendar escaping", async () => {
	const feed = await create();
	expect(/^ditero_feed_[A-Za-z0-9_-]{43}$/.test(feed.secret)).toBe(true);
	expect(
		feed.path === `/api/v1/calendar-feeds/${feed.secret}/calendar.ics`,
	).toBe(true);
	const result = await app.handle(new Request(`http://localhost${feed.path}`));
	expect(result.status).toBe(200);
	expect(result.headers.get("content-type")).toBe(
		"text/calendar; charset=utf-8",
	);
	expect(result.headers.get("cache-control")).toBe("no-store");
	const body = await result.text();
	expect(body).toContain("SUMMARY:Task\\, ☕");
	expect(body).toContain("DESCRIPTION:Line one\\nLine two");
	expect(body).not.toContain("RRULE:");
});
test("empty feeds still require current original membership", async () => {
	const feed = await create(empty);
	expect(
		await (await downloadCalendarFeed(runtime, feed.secret)).text(),
	).not.toContain("BEGIN:VTODO");
	await admin.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[viewer, workspace],
	);
	try {
		await expect(
			downloadCalendarFeed(runtime, feed.secret),
		).rejects.toMatchObject({ status: 404 });
	} finally {
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'viewer')",
			[`${prefix}_viewer_seat`, viewer, workspace],
		);
	}
});
test("nonmembers cannot create or revoke another account's feed", async () => {
	await expect(
		createCalendarFeed(runtime, other, { name: "Hidden", listId: list }),
	).rejects.toMatchObject({ status: 404 });
	const feed = await create();
	await expect(
		revokeCalendarFeed(runtime, other, feed.id),
	).rejects.toMatchObject({ status: 404 });
	expect((await downloadCalendarFeed(runtime, feed.secret)).status).toBe(200);
});
test("revoke is idempotent and refuses later downloads", async () => {
	const feed = await create();
	await revokeCalendarFeed(runtime, viewer, feed.id);
	await revokeCalendarFeed(runtime, viewer, feed.id);
	await expect(
		downloadCalendarFeed(runtime, feed.secret),
	).rejects.toMatchObject({ status: 404 });
});
test("deleted account refuses a retained empty capability", async () => {
	const feed = await create(empty);
	await admin.query(
		'update "user" set deleted_at=statement_timestamp() where id=$1',
		[viewer],
	);
	try {
		await expect(
			downloadCalendarFeed(runtime, feed.secret),
		).rejects.toMatchObject({ status: 404 });
	} finally {
		await admin.query('update "user" set deleted_at=null where id=$1', [
			viewer,
		]);
	}
});
test("past but valid-lifetime fixture refuses expiry", async () => {
	const secret = `ditero_feed_${randomBytes(32).toString("base64url")}`;
	await admin.query(
		"insert into calendar_feed(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,'Expired',$5,'test',statement_timestamp()-interval '2 days',statement_timestamp()-interval '1 day')",
		[
			randomUUID(),
			viewer,
			empty,
			workspace,
			createHash("sha256").update(secret).digest("hex"),
		],
	);
	await expect(downloadCalendarFeed(runtime, secret)).rejects.toMatchObject({
		status: 404,
	});
});
test("fixed capability refuses query scope and token namespace substitution", async () => {
	const feed = await create();
	const query = await app.handle(
		new Request(`http://localhost${feed.path}?listId=${empty}`),
	);
	expect(query.status).toBe(400);
	expect(query.headers.get("content-type")).toContain(
		"application/problem+json",
	);
	const wrong = await app.handle(
		new Request(
			`http://localhost${feed.path.replace("ditero_feed_", "ditero_pat_")}`,
		),
	);
	expect(wrong.status).toBe(404);
});
test("immutable scope/hash/lifetime and revocation cannot be rebound", async () => {
	const feed = await create();
	const client = await runtime.connect();
	await withFixtureClient(client, async () => {
		for (const patch of [
			"list_id=$2",
			"secret_hash=$2",
			"expires_at=expires_at+interval '1 day'",
		]) {
			await client.query("begin");
			await client.query("select set_config('ditero.user_id',$1,true)", [
				viewer,
			]);
			await expect(
				client.query(
					`update calendar_feed set ${patch} where id=$1`,
					patch.includes("$2")
						? [feed.id, patch.startsWith("list") ? empty : "a".repeat(64)]
						: [feed.id],
				),
			).rejects.toMatchObject({ code: "23514" });
			await client.query("rollback");
		}
	});
	expect((await downloadCalendarFeed(runtime, feed.secret)).status).toBe(200);
	await revokeCalendarFeed(runtime, viewer, feed.id);
	const before = (await listCalendarFeeds(runtime, viewer))[0].revokedAt;
	expect(before).not.toBeNull();
	const revokedClient = await runtime.connect();
	await withFixtureClient(revokedClient, async () => {
		for (const patch of [
			"revoked_at=null",
			"revoked_at=revoked_at+interval '1 second'",
		]) {
			await revokedClient.query("begin");
			await revokedClient.query("select set_config('ditero.user_id',$1,true)", [
				viewer,
			]);
			await expect(
				revokedClient.query(`update calendar_feed set ${patch} where id=$1`, [
					feed.id,
				]),
			).rejects.toMatchObject({ code: "23514" });
			await revokedClient.query("rollback");
		}
	});
	expect(
		(await listCalendarFeeds(runtime, viewer))[0].revokedAt?.getTime(),
	).toBe(before?.getTime());
	await expect(
		downloadCalendarFeed(runtime, feed.secret),
	).rejects.toMatchObject({ status: 404 });
});
test("concurrent creation enforces the active cap without partial rows", async () => {
	const results = await Promise.allSettled(
		Array.from({ length: 21 }, () => create()),
	);
	expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(20);
	const refused = results.find((r) => r.status === "rejected");
	expect(
		refused && refused.status === "rejected" && refused.reason.status,
	).toBe(409);
	expect(await listCalendarFeeds(runtime, viewer)).toHaveLength(20);
}, 15000);
test("hash-only authentication exposes exactly the presented capability", async () => {
	const feed = await create();
	const client = await runtime.connect();
	await withFixtureClient(client, async () => {
		await client.query("begin");
		await client.query(
			"select set_config('ditero.calendar_feed_hash',$1,true)",
			[createHash("sha256").update(feed.secret).digest("hex")],
		);
		expect((await client.query("select id from calendar_feed")).rows).toEqual([
			{ id: feed.id },
		]);
		await client.query(
			"select set_config('ditero.calendar_feed_hash',$1,true)",
			["0".repeat(64)],
		);
		expect((await client.query("select id from calendar_feed")).rowCount).toBe(
			0,
		);
	});
});
test("deleted and recreated list identity cannot revive an old capability", async () => {
	const feed = await create(empty);
	await admin.query("delete from list where id=$1", [empty]);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Recreated','a1')",
		[empty, workspace, owner],
	);
	await expect(
		downloadCalendarFeed(runtime, feed.secret),
	).rejects.toMatchObject({ status: 404 });
	expect(
		(await downloadCalendarFeed(runtime, (await create(empty)).secret)).status,
	).toBe(200);
});
test("revocation during the account lock wait refuses the original candidate", async () => {
	const feed = await create(empty);
	const blocker = await admin.connect();
	let pending: Promise<{ error: unknown } | { response: Response }> | undefined;
	await withFixtureClient(
		blocker,
		async () => {
			await blocker.query("begin");
			await blocker.query('select id from "user" where id=$1 for update', [
				viewer,
			]);
			pending = downloadCalendarFeed(runtime, feed.secret).then(
				(response) => ({ response }),
				(error) => ({ error }),
			);
			const deadline = performance.now() + 750;
			let blocked = false;
			while (performance.now() < deadline) {
				blocked =
					(
						await admin.query(
							"select pid from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
							[role],
						)
					).rowCount === 1;
				if (blocked) break;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(blocked).toBe(true);
			await blocker.query(
				"update calendar_feed set revoked_at=statement_timestamp() where id=$1",
				[feed.id],
			);
			await blocker.query("commit");
			expect(await pending).toMatchObject({ error: { status: 404 } });
		},
		() => pending,
	);
});
test("oversized task text returns a JSON refusal without partial calendar bytes", async () => {
	const feed = await create();
	await admin.query("update task set notes=repeat('x',131073) where id=$1", [
		`${prefix}_task`,
	]);
	try {
		const response = await app.handle(
			new Request(`http://localhost${feed.path}`),
		);
		expect(response.status).toBe(422);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json",
		);
		expect(await response.text()).not.toContain("BEGIN:VCALENDAR");
	} finally {
		await admin.query(
			"update task set notes='Line one'||chr(10)||'Line two' where id=$1",
			[`${prefix}_task`],
		);
	}
});

test("management routes retain cookie authentication and origin guards", async () => {
	const management = calendarFeedRoutes(
		runtime,
		makeGuards(["http://localhost"], async () => null),
		async () => true,
	);
	const response = await management.handle(
		new Request("http://localhost/api/calendar-feeds"),
	);
	expect(response.status).toBe(401);
	const foreign = await management.handle(
		new Request("http://localhost/api/calendar-feeds", {
			method: "POST",
			headers: {
				origin: "http://foreign.example",
				"content-type": "application/json",
			},
			body: JSON.stringify({ name: "Feed", listId: list }),
		}),
	);
	expect(foreign.status).toBe(403);
	const noSession = await management.handle(
		new Request("http://localhost/api/calendar-feeds", {
			method: "POST",
			headers: {
				origin: "http://localhost",
				"content-type": "application/json",
			},
			body: JSON.stringify({ name: "Feed", listId: list }),
		}),
	);
	expect(noSession.status).toBe(401);
});

test("365-day creation uses one insertion instant after a measured lock wait", async () => {
	const blocker = await admin.connect();
	let pending:
		| Promise<
				| { error: unknown }
				| { feed: Awaited<ReturnType<typeof createCalendarFeed>> }
		  >
		| undefined;
	await withFixtureClient(
		blocker,
		async () => {
			await blocker.query("begin");
			await blocker.query('select id from "user" where id=$1 for update', [
				viewer,
			]);
			pending = createCalendarFeed(runtime, viewer, {
				name: "Maximum lifetime",
				listId: empty,
				expiresInDays: 365,
			}).then(
				(feed) => ({ feed }),
				(error) => ({ error }),
			);
			const deadline = performance.now() + 750;
			let transactionStart: Date | undefined;
			while (performance.now() < deadline) {
				const waiting = await admin.query<{ xact_start: Date }>(
					"select xact_start from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
					[role],
				);
				if (waiting.rowCount === 1) {
					transactionStart = waiting.rows[0].xact_start;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(transactionStart).toBeDefined();
			await blocker.query("select pg_sleep(0.05)");
			await blocker.query("commit");
			const result = await pending;
			expect("error" in result).toBe(false);
			if (!("feed" in result))
				throw new Error("Maximum lifetime creation refused");
			const row = await admin.query<{
				delayed: boolean;
				exactLifetime: boolean;
			}>(
				`select created_at>$2 as delayed,expires_at-created_at=interval '365 days' as "exactLifetime" from calendar_feed where id=$1`,
				[result.feed.id, transactionStart],
			);
			expect(row.rowCount).toBe(1);
			expect(row.rows[0]).toEqual({ delayed: true, exactLifetime: true });
		},
		() => pending,
	);
});

test("active feed remains visible beyond 100 newer revoked records", async () => {
	const feed = await create();
	await admin.query("select pg_sleep(0.02)");
	const ids = Array.from({ length: 101 }, () => randomUUID());
	const hashes = ids.map((id) => createHash("sha256").update(id).digest("hex"));
	await admin.query(
		"insert into calendar_feed(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at,revoked_at) select id,$3,$4,$5,'History',hash,'test',statement_timestamp(),statement_timestamp()+interval '90 days',statement_timestamp() from unnest($1::uuid[],$2::text[]) as history(id,hash)",
		[ids, hashes, viewer, empty, workspace],
	);
	const positive = await admin.query(
		"select count(*)::integer count from calendar_feed where id=any($1::uuid[]) and created_at>(select created_at from calendar_feed where id=$2)",
		[ids, feed.id],
	);
	expect(positive.rows[0].count).toBe(101);
	const metadata = await listCalendarFeeds(runtime, viewer);
	expect(metadata).toHaveLength(100);
	expect(metadata[0].id).toBe(feed.id);
	expect(metadata[0].revokedAt).toBeNull();
	expect((await downloadCalendarFeed(runtime, feed.secret)).status).toBe(200);
	await revokeCalendarFeed(runtime, viewer, feed.id);
	await expect(
		downloadCalendarFeed(runtime, feed.secret),
	).rejects.toMatchObject({ status: 404 });
});
