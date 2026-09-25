import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { acceptInvite } from "../../src/auth/invite-accept.ts";
import { createInvite } from "../../src/auth/invite-create.ts";
import {
	claimFastInvite,
	finalizeFastInvite,
} from "../../src/auth/invite-fast-path.ts";
import * as tables from "../../src/db/schema.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const runtime = new Pool({ connectionString: databaseURL, max: 2 });
const db = drizzle(runtime, { schema: tables });
const oldDue = new Date("2026-09-20T10:00:00.000Z");
const cutoff = new Date("2026-09-21T10:00:00.000Z");

async function guard(status: "pending" | "blocked" | "active") {
	await admin.query(
		`insert into task_notification_activation
		(task_id,status,generation,import_occurrence_cutoff,recipient_generation_cutoff,completion_mode)
		values ('task',$1,1,$2,$2,$3)`,
		[
			status,
			status === "active" ? cutoff : null,
			status === "active" ? "import" : null,
		],
	);
	await admin.query(
		`insert into task_notification_recipient
		(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
		values ('task','owner',$1,1,$2,$3)`,
		[status === "active", status === "active" ? cutoff : null, oldDue],
	);
}

async function invite(
	token: string,
	options: { claimed?: boolean; accepted?: boolean; role?: string } = {},
) {
	await admin.query(
		`insert into invite (id,workspace_id,role,email,token,status,uses,max_uses,
		expires_at,created_by,attach_task_id,attach_kind,claimed_by,claimed_at)
		values ($1,'ws',$2,'joiner@example.test',$3,$4,$5,1,now()+interval '10 minutes',
		'owner','task','assign',$6,$7)`,
		[
			`inv-${token}`,
			options.role ?? "viewer",
			token,
			options.accepted ? "accepted" : "pending",
			options.accepted ? 1 : 0,
			options.claimed || options.accepted ? "joiner" : null,
			options.claimed || options.accepted ? new Date() : null,
		],
	);
}

async function snapshot() {
	const [invites, pairs, guardRows, recipients, members] = await Promise.all([
		admin.query(
			"select token,uses,claimed_by,status from invite order by token",
		),
		admin.query("select task_id,user_id from task_assignee order by user_id"),
		admin.query(
			"select generation,recipient_generation_cutoff from task_notification_activation where task_id='task'",
		),
		admin.query(
			"select user_id,active,generation,overdue_suppressed_due_at from task_notification_recipient where task_id='task' order by user_id",
		),
		admin.query(
			"select user_id,role from membership where workspace_id='ws' order by user_id",
		),
	]);
	return {
		invites: invites.rows,
		pairs: pairs.rows,
		guard: guardRows.rows,
		recipients: recipients.rows,
		members: members.rows,
	};
}

beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists (select from pg_roles where rolname = 'ditero_invite_activation_test') then
		 create role ditero_invite_activation_test nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
		 end if; end $$`,
	);
	await admin.query(
		"grant usage on schema public to ditero_invite_activation_test",
	);
	await admin.query(
		"grant select, insert, update, delete on all tables in schema public to ditero_invite_activation_test",
	);
	runtime.on("connect", (client) => {
		void client.query("set role ditero_invite_activation_test");
	});
});

beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(`insert into "user" (id,name,email,email_verified) values
		('owner','Owner','owner@example.test',false),
		('joiner','Joiner','joiner@example.test',false),
		('other','Other','other@example.test',false)`);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ('ws','Shared','owner','shared')",
	);
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ('owner-seat','owner','ws','owner')",
	);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,sort_key) values ('list','ws','owner','List','a0')",
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key,due_at) values ('task','list','Task','a0',$1)",
		[oldDue],
	);
});

afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.end();
});

test.each([
	"pending",
	"blocked",
] as const)("%s task refuses invite creation and redemption before token use", async (status) => {
	await guard(status);
	const role = await runtime.query(
		"select current_user as role, rolbypassrls from pg_roles where rolname=current_user",
	);
	expect(role.rows[0]).toMatchObject({
		role: "ditero_invite_activation_test",
		rolbypassrls: false,
	});
	await expect(
		createInvite(
			{
				workspaceId: "ws",
				role: "viewer",
				attachTaskId: "task",
				attachKind: "assign",
			},
			"owner",
			db,
			{},
		),
	).rejects.toMatchObject({ status: 409 });
	await invite("legacy");
	const before = await snapshot();
	await expect(
		acceptInvite("legacy", "joiner", "joiner@example.test", db),
	).rejects.toThrow();
	expect(await snapshot()).toEqual(before);
});

test("new viewer recipient advances generation and suppresses the old due without writer identity leaking", async () => {
	await guard("active");
	const created = await createInvite(
		{
			workspaceId: "ws",
			role: "viewer",
			email: "joiner@example.test",
			attachTaskId: "task",
			attachKind: "assign",
		},
		"owner",
		db,
		{},
	);
	await acceptInvite(created.token, "joiner", "joiner@example.test", db);
	const state = await snapshot();
	expect(state.invites[0]).toMatchObject({ uses: 1, status: "accepted" });
	expect(state.pairs).toEqual([{ task_id: "task", user_id: "joiner" }]);
	expect(state.guard[0].generation).toBe(2);
	expect(state.recipients).toMatchObject([
		{
			user_id: "joiner",
			active: true,
			generation: 2,
			overdue_suppressed_due_at: oldDue,
		},
		{ user_id: "owner", active: false, generation: 1 },
	]);
	expect(state.members).toMatchObject([
		{ user_id: "joiner", role: "viewer" },
		{ user_id: "owner", role: "owner" },
	]);
	const scope = await runtime.query(
		"select current_setting('ditero.activation_scope',true) as scope, current_setting('ditero.user_id',true) as user_id",
	);
	expect([null, ""]).toContain(scope.rows[0].scope);
	expect([null, ""]).toContain(scope.rows[0].user_id);
});

test("returning recipient keeps cleared suppression and no-op assignment keeps generation", async () => {
	await guard("active");
	await admin.query(
		"insert into task_notification_recipient (task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at) values ('task','joiner',false,1,$1,null)",
		[cutoff],
	);
	await invite("returning");
	await acceptInvite("returning", "joiner", "joiner@example.test", db);
	let state = await snapshot();
	expect(state.guard[0].generation).toBe(2);
	expect(
		state.recipients.find((row) => row.user_id === "joiner"),
	).toMatchObject({
		active: true,
		generation: 2,
		overdue_suppressed_due_at: null,
	});
	await invite("noop");
	await acceptInvite("noop", "joiner", "joiner@example.test", db);
	state = await snapshot();
	expect(state.guard[0].generation).toBe(2);
	expect(state.pairs).toHaveLength(1);
});

test("pending fast claim and finalize leave reservation, use, membership and assignment unchanged", async () => {
	await guard("pending");
	await invite("fast-pending");
	const before = await snapshot();
	await expect(
		claimFastInvite(runtime, "fast-pending", "joiner", "joiner@example.test"),
	).rejects.toMatchObject({ reason: "conflict" });
	expect(await snapshot()).toEqual(before);
	await admin.query(
		"update invite set claimed_by='joiner', claimed_at=now() where token='fast-pending'",
	);
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ('joiner-seat','joiner','ws','viewer')",
	);
	const reserved = await snapshot();
	await expect(
		finalizeFastInvite(runtime, "fast-pending", "joiner", "fallback"),
	).rejects.toMatchObject({ reason: "conflict" });
	expect(await snapshot()).toEqual(reserved);
});

test("active fast claim reserves a key grant and finalize publishes the new recipient", async () => {
	await guard("active");
	await admin.query(
		"insert into workspace_key (id,workspace_id,version,commitment,minted_by) values ('key','ws',1,'commitment','owner')",
	);
	await invite("fast-active");
	const claimed = await claimFastInvite(
		runtime,
		"fast-active",
		"joiner",
		"joiner@example.test",
	);
	expect(claimed).toMatchObject({ workspaceId: "ws", grantState: "pending" });
	let state = await snapshot();
	expect(state.invites[0]).toMatchObject({ claimed_by: "joiner", uses: 0 });
	expect(state.pairs).toHaveLength(0);
	expect(state.guard[0].generation).toBe(1);
	await finalizeFastInvite(runtime, "fast-active", "joiner", "fallback");
	state = await snapshot();
	expect(state.invites[0]).toMatchObject({
		claimed_by: "joiner",
		uses: 1,
		status: "accepted",
	});
	expect(state.pairs).toEqual([{ task_id: "task", user_id: "joiner" }]);
	expect(state.guard[0].generation).toBe(2);
	expect(
		state.recipients.find((row) => row.user_id === "joiner"),
	).toMatchObject({
		active: true,
		generation: 2,
		overdue_suppressed_due_at: oldDue,
	});
});

test("completed fast finalize reload is read-only even after task becomes pending", async () => {
	await guard("active");
	await invite("completed", { accepted: true });
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ('joiner-seat','joiner','ws','viewer')",
	);
	await admin.query(
		"insert into task_assignee (id,task_id,user_id) values ('task:joiner','task','joiner')",
	);
	await admin.query(
		"insert into task_notification_recipient (task_id,user_id,active,generation,cutoff) values ('task','joiner',true,1,$1)",
		[cutoff],
	);
	await admin.query(
		"update task_notification_activation set status='pending',completion_mode=null where task_id='task'",
	);
	const before = await snapshot();
	await expect(
		finalizeFastInvite(runtime, "completed", "joiner", "fallback"),
	).resolves.toMatchObject({ workspaceId: "ws" });
	expect(await snapshot()).toEqual(before);
});

test("guard publication while invite creation waits on the task rejects the new token", async () => {
	const blocker = await admin.connect();
	let pending: Promise<unknown> | undefined;
	try {
		await blocker.query("begin");
		await blocker.query("select id from task where id='task' for update");
		const pid = (
			await blocker.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		pending = createInvite(
			{
				workspaceId: "ws",
				role: "viewer",
				attachTaskId: "task",
				attachKind: "assign",
			},
			"owner",
			db,
			{},
		).catch((error: unknown) => error);
		await expect
			.poll(
				async () =>
					(
						await admin.query(
							"select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
							[pid],
						)
					).rowCount,
			)
			.toBe(1);
		await blocker.query(
			"insert into task_notification_activation (task_id,status,generation) values ('task','pending',1)",
		);
		await blocker.query("commit");
		expect(await pending).toMatchObject({ status: 409 });
		expect((await admin.query("select id from invite")).rowCount).toBe(0);
	} finally {
		await blocker.query("rollback").catch(() => undefined);
		blocker.release();
		await pending;
	}
}, 10_000);

test("invite acceptance holds the task against a later guard transition", async () => {
	await guard("active");
	await invite("locked-token");
	const tokenBlocker = await admin.connect();
	const guardWriter = await admin.connect();
	let accepting: Promise<unknown> | undefined;
	let locking: Promise<unknown> | undefined;
	try {
		await tokenBlocker.query("begin");
		await tokenBlocker.query(
			"select id from invite where token='locked-token' for update",
		);
		const tokenPid = (
			await tokenBlocker.query<{ pid: number }>(
				"select pg_backend_pid() as pid",
			)
		).rows[0].pid;
		accepting = acceptInvite(
			"locked-token",
			"joiner",
			"joiner@example.test",
			db,
		).catch((error: unknown) => error);
		let acceptPid = 0;
		await expect
			.poll(async () => {
				const rows = await admin.query<{ pid: number }>(
					"select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
					[tokenPid],
				);
				acceptPid = rows.rows[0]?.pid ?? 0;
				return acceptPid;
			})
			.not.toBe(0);
		await guardWriter.query("begin");
		const writerPid = (
			await guardWriter.query<{ pid: number }>("select pg_backend_pid() as pid")
		).rows[0].pid;
		locking = guardWriter.query(
			"select id from task where id='task' for update",
		);
		await expect
			.poll(async () => {
				const rows = await admin.query<{ blockers: number[] }>(
					"select pg_blocking_pids($1) as blockers",
					[writerPid],
				);
				return rows.rows[0]?.blockers ?? [];
			})
			.toContain(acceptPid);
		await tokenBlocker.query("commit");
		expect(await accepting).toMatchObject({ workspaceId: "ws" });
		await locking;
		await guardWriter.query(
			"update task_notification_activation set status='pending',completion_mode=null where task_id='task'",
		);
		await guardWriter.query("commit");
		const state = await snapshot();
		expect(state.invites[0]).toMatchObject({ uses: 1, status: "accepted" });
		expect(state.pairs).toEqual([{ task_id: "task", user_id: "joiner" }]);
		expect(state.guard[0].generation).toBe(2);
	} finally {
		await tokenBlocker.query("rollback").catch(() => undefined);
		await guardWriter.query("rollback").catch(() => undefined);
		tokenBlocker.release();
		guardWriter.release();
		await accepting;
		await locking;
	}
}, 10_000);
