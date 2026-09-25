import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: url });
const runtime = new Pool({ connectionString: url });
const zdb = zeroNodePg(schema, runtime);
const cutoff = new Date("2026-09-21T10:00:00.000Z");
const due = new Date("2026-09-20T10:00:00.000Z");

async function remove(actor = "alice", membershipId = "mb") {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, actor, () =>
			mutators.membership.remove.fn({
				tx,
				ctx: { id: actor },
				args: { id: membershipId },
			}),
		),
	);
}

async function role(
	actor: string,
	membershipId: string,
	next: "viewer" | "member",
) {
	return zdb.transaction((tx) =>
		withZeroUserContext(tx, actor, () =>
			mutators.membership.setRole.fn({
				tx,
				ctx: { id: actor },
				args: { id: membershipId, role: next },
			}),
		),
	);
}

async function task(
	id: string,
	listId = "list",
	fallback: string | null = null,
) {
	await admin.query(
		"insert into task (id,list_id,title,sort_key,due_at,fallback_user_id) values ($1,$2,$1,'a0',$3,$4)",
		[id, listId, due, fallback],
	);
}

async function guard(
	id: string,
	status: "active" | "pending",
	owner: string | null = null,
	evidence: unknown = null,
) {
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,completion_mode,owning_owner_user_id,
		expected_relationship_digest,expected_relationship_count,expected_relationship_bytes,expected_relationships)
		values ($1,$2,7,$3,$3,$4,$5,$6,$7,
		case when $8::jsonb is null then null else octet_length($8::jsonb::text) end,$8::jsonb)`,
		[
			id,
			status,
			status === "active" ? cutoff : null,
			status === "active" ? "import" : null,
			owner,
			evidence ? "a".repeat(64) : null,
			evidence ? 1 : null,
			evidence ? JSON.stringify(evidence) : null,
		],
	);
	await admin.query(
		"insert into task_notification_recipient(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at) values ($1,'bob',true,7,$2,$3)",
		[id, cutoff, due],
	);
}

beforeAll(async () => {
	await admin.query(`do $$ begin if not exists (select from pg_roles where rolname='ditero_membership_activation_test') then
		create role ditero_membership_activation_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		end if; end $$`);
	await admin.query(
		"grant usage on schema public to ditero_membership_activation_test",
	);
	await admin.query(
		"grant select,insert,update,delete on all tables in schema public to ditero_membership_activation_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_membership_activation_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(`insert into "user"(id,name,email,email_verified) values
		('alice','Alice','alice@example.test',false),('bob','Bob','bob@example.test',false),
		('cara','Cara','cara@example.test',false),('dana','Dana','dana@example.test',false)`);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values ('ws','Shared','alice','shared')",
	);
	await admin.query(`insert into membership(id,user_id,workspace_id,role) values
		('ma','alice','ws','owner'),('mb','bob','ws','member'),('mc','cara','ws','owner'),('md','dana','ws','viewer')`);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values ('list','ws','alice','List','tasks','a0')",
	);
});

afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.end();
});

test("restricted-role removal blocks affected guards and retains every fence", async () => {
	await task("assigned");
	await admin.query(
		"insert into task_assignee(id,task_id,user_id) values ('seat','assigned','bob')",
	);
	await guard("assigned", "active");
	await task("fallback", "list", "bob");
	await guard("fallback", "active");
	await task("frozen");
	await guard("frozen", "pending", null, {
		assignees: [{ userId: "bob", membershipId: "mb" }],
		ownerFallback: null,
		escalationFallback: null,
	});
	await task("owner-provenance");
	await guard("owner-provenance", "pending", "bob");
	await task("native", "list", "bob");
	await task("unaffected");
	await guard("unaffected", "active");
	await task("historical-owner");
	await guard("historical-owner", "active", "bob");
	await remove();
	const guards =
		await admin.query(`select task_id,status,generation,completion_mode,
		import_occurrence_cutoff,recipient_generation_cutoff from task_notification_activation order by task_id`);
	expect(
		guards.rows
			.filter(
				(row) => !["unaffected", "historical-owner"].includes(row.task_id),
			)
			.map((row) => row.status),
	).toEqual(["blocked", "blocked", "blocked", "blocked"]);
	expect(guards.rows.find((row) => row.task_id === "unaffected")?.status).toBe(
		"active",
	);
	expect(
		guards.rows.find((row) => row.task_id === "historical-owner")?.status,
	).toBe("active");
	for (const row of guards.rows.filter(
		(row) => !["unaffected", "historical-owner"].includes(row.task_id),
	)) {
		expect(row.generation).toBe(7);
		expect(row.completion_mode).toBeNull();
	}
	const recipients = await admin.query(
		"select task_id,active,generation,cutoff,overdue_suppressed_due_at from task_notification_recipient order by task_id",
	);
	for (const row of recipients.rows.filter(
		(row) => !["unaffected", "historical-owner"].includes(row.task_id),
	)) {
		expect(row).toMatchObject({
			active: false,
			generation: 7,
			cutoff,
			overdue_suppressed_due_at: due,
		});
	}
	expect(
		recipients.rows.find((row) => row.task_id === "unaffected")?.active,
	).toBe(true);
	expect(
		(await admin.query("select 1 from task_assignee where user_id='bob'"))
			.rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from task where fallback_user_id='bob'",
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(await admin.query("select 1 from membership where id='mb'")).rowCount,
	).toBe(0);
});

test("list and workspace owner transfer blocks guarded tasks but preserves native rows", async () => {
	await admin.query("update membership set role='owner' where id='mb'");
	await admin.query("update workspace set owner_id='bob' where id='ws'");
	await admin.query("update list set owner_id='bob' where id='list'");
	await task("guarded");
	await guard("guarded", "pending");
	await task("native");
	await remove();
	expect(
		(await admin.query("select owner_id from workspace where id='ws'")).rows[0]
			.owner_id,
	).toBe("alice");
	expect(
		(await admin.query("select owner_id from list where id='list'")).rows[0]
			.owner_id,
	).toBe("alice");
	expect(
		(
			await admin.query(
				"select status from task_notification_activation where task_id='guarded'",
			)
		).rows[0].status,
	).toBe("blocked");
	expect(
		(await admin.query("select 1 from task where id='native'")).rowCount,
	).toBe(1);
});

test("viewer demotion retains assignment and active guard; independent role gates hold", async () => {
	await task("task");
	await guard("task", "active");
	await admin.query(
		"insert into task_assignee(id,task_id,user_id) values ('seat','task','bob')",
	);
	await role("alice", "mb", "viewer");
	expect(
		(await admin.query("select role from membership where id='mb'")).rows[0]
			.role,
	).toBe("viewer");
	expect(
		(await admin.query("select 1 from task_assignee where id='seat'")).rowCount,
	).toBe(1);
	expect(
		(
			await admin.query(
				"select status,generation from task_notification_activation where task_id='task'",
			)
		).rows[0],
	).toMatchObject({ status: "active", generation: 7 });
	await expect(remove("bob", "md")).rejects.toThrow(/access denied/);
	expect(
		(await admin.query("select 1 from membership where id='md'")).rowCount,
	).toBe(1);
});

test("security cleanup pages past the import evidence limit", async () => {
	await admin.query(`insert into task(id,list_id,title,sort_key,fallback_user_id)
		select 'bulk-'||lpad(n::text,5,'0'),'list','Bulk','a0','bob'
		from generate_series(1,50001) as n`);
	await remove();
	expect(
		(
			await admin.query(
				"select count(*)::int as n from task where fallback_user_id='bob'",
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int as n from task where id like 'bulk-%'",
			)
		).rows[0].n,
	).toBe(50001);
}, 120000);

test("the first page includes empty list, task, and assignment IDs", async () => {
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values ('','ws','bob','Empty ID','tasks','a0')",
	);
	await task("", "", "bob");
	await admin.query(
		"insert into task_assignee(id,task_id,user_id) values ('','','bob')",
	);
	await task("guarded-empty-list", "");
	await guard("guarded-empty-list", "pending");
	await remove();
	expect(
		(await admin.query("select owner_id from list where id='' ")).rows[0]
			.owner_id,
	).toBe("alice");
	expect(
		(await admin.query("select fallback_user_id from task where id='' "))
			.rows[0].fallback_user_id,
	).toBeNull();
	expect(
		(await admin.query("select 1 from task_assignee where id='' ")).rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select status from task_notification_activation where task_id='guarded-empty-list'",
			)
		).rows[0].status,
	).toBe("blocked");
});

async function untilBlocked(blocker: number): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const rows = await admin.query(
			"select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))",
			[blocker],
		);
		if (rows.rowCount) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Expected a blocked backend PID");
}

test("an in-flight producer task lock makes removal wait before invalidation", async () => {
	await task("task", "list", "bob");
	await guard("task", "active");
	const producer = await runtime.connect();
	try {
		await producer.query("begin");
		await producer.query("set local role ditero_membership_activation_test");
		await producer.query("select set_config('ditero.user_id','alice',true)");
		await producer.query("select id from task where id='task' for share");
		const producerPid = Number(
			(await producer.query("select pg_backend_pid() as pid")).rows[0].pid,
		);
		const removing = remove();
		await untilBlocked(producerPid);
		await producer.query("commit");
		await removing;
		expect(
			(
				await admin.query(
					"select status from task_notification_activation where task_id='task'",
				)
			).rows[0].status,
		).toBe("blocked");
	} finally {
		await producer.query("rollback");
		producer.release();
	}
});

test("a producer waits for removal and sees the blocked guard", async () => {
	await task("task", "list", "bob");
	await guard("task", "active");
	let finish!: () => void;
	let started!: () => void;
	const hold = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	let removerPid = 0;
	const removing = zdb.transaction((tx) =>
		withZeroUserContext(tx, "alice", async () => {
			await mutators.membership.remove.fn({
				tx,
				ctx: { id: "alice" },
				args: { id: "mb" },
			});
			const rows = Array.from(
				await tx.dbTransaction.query("select pg_backend_pid() as pid", []),
			);
			removerPid = Number(rows[0]?.pid);
			started();
			await hold;
		}),
	);
	await ready;
	const producer = await runtime.connect();
	try {
		await producer.query("begin");
		await producer.query("set local role ditero_membership_activation_test");
		await producer.query("select set_config('ditero.user_id','alice',true)");
		const lookup = producer.query(
			"select id from task where id='task' for share",
		);
		await untilBlocked(removerPid);
		finish();
		await removing;
		await lookup;
		const rows = await producer.query(
			"select status from task_notification_activation where task_id='task'",
		);
		expect(rows.rows[0].status).toBe("blocked");
		await producer.query("commit");
	} finally {
		finish();
		await producer.query("rollback");
		producer.release();
	}
});
