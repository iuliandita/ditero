import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { e2eEnabled } from "../../src/config/e2e.ts";
import {
	apiListDeleteAckSchema,
	apiListDeletionObservationSchema,
} from "../../src/domain/public-api-list-deletion.ts";
import { attachmentRoutes } from "../../src/server/attachments/routes.ts";
import type { Guards, Session } from "../../src/server/guards.ts";
import { observeDeletionTasks } from "../../src/server/public-api/list-deletion-observation.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";
import { FsBlobStore } from "../../src/server/storage/fs-store.ts";

const databaseURL = process.env.DATABASE_URL;
if (
	!databaseURL ||
	process.env.NODE_ENV !== "test" ||
	new URL(databaseURL).pathname !== "/ditero_list_deletion616"
)
	throw new Error(
		"Dedicated list deletion test database and NODE_ENV=test required",
	);
const admin = new Pool({ connectionString: databaseURL });
const prefix = `list_delete_${randomUUID().replaceAll("-", "")}`;
const role = `${prefix}_runtime`;
const password = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
const alice = `${prefix}_alice`;
const bob = `${prefix}_bob`;
const outsider = `${prefix}_outsider`;
const workspace = `${prefix}_workspace`;
const hidden = `${prefix}_hidden`;
const taskList = `${prefix}_tasks`;
const task = `${prefix}_task`;

let token: string;
let tokenId: string;
let bobToken: string;
let createdRole = false;
let directory: string;
let store: FsBlobStore;

async function collectCleanup(
	actions: (() => Promise<unknown>)[],
): Promise<unknown[]> {
	const failures: unknown[] = [];
	for (const action of actions) {
		try {
			await action();
		} catch (error) {
			failures.push(error);
		}
	}
	return failures;
}
function finishCleanup(failures: unknown[]): void {
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(
			failures,
			"Fixture cleanup failed; first failure retained as cause",
			{ cause: failures[0] },
		);
}
async function cleanupData() {
	finishCleanup(
		await collectCleanup([
			() =>
				admin.query(
					"delete from attachment where workspace_id=any($1::text[])",
					[[workspace, hidden]],
				),
			() =>
				admin.query(
					"delete from workspace_key where workspace_id=any($1::text[])",
					[[workspace, hidden]],
				),
			() =>
				admin.query(
					"delete from task where list_id in (select id from list where workspace_id=any($1::text[]))",
					[[workspace, hidden]],
				),
			() =>
				admin.query("delete from list where workspace_id=any($1::text[])", [
					[workspace, hidden],
				]),
			() =>
				admin.query("delete from folder where workspace_id=any($1::text[])", [
					[workspace, hidden],
				]),
			() =>
				admin.query(
					"delete from membership where workspace_id=any($1::text[])",
					[[workspace, hidden]],
				),
			() =>
				admin.query("delete from workspace where id=any($1::text[])", [
					[workspace, hidden],
				]),
			() =>
				admin.query('delete from "user" where id=any($1::text[])', [
					[alice, bob, outsider],
				]),
		]),
	);
}

beforeAll(async () => {
	expect(
		(await admin.query("select current_database() as name")).rows[0].name,
	).toBe("ditero_list_deletion616");
	expect(
		(
			await admin.query(
				"select count(*)::int as count from drizzle.__drizzle_migrations",
			)
		).rows[0].count,
	).toBe(71);
	vi.stubEnv("DITERO_E2E_ENABLED", "true");
	const statement = await admin.query<{ statement: string }>(
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls', $1::text, $2::text) as statement",
		[role, password],
	);
	await admin.query(statement.rows[0].statement);
	createdRole = true;
	directory = await mkdtemp(join(tmpdir(), "ditero-list-delete-"));
	store = new FsBlobStore(directory);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	const identity = await runtime.query(
		"select current_user,session_user,rolsuper,rolbypassrls,rolcanlogin,rolinherit,(select count(*)::int from pg_auth_members where member=r.oid) as memberships,(select count(*)::int from pg_class where relowner=r.oid) as owned_relations from pg_roles r where rolname=current_user",
	);
	expect(identity.rows[0]).toEqual({
		current_user: role,
		session_user: role,
		rolsuper: false,
		rolbypassrls: false,
		rolcanlogin: true,
		rolinherit: false,
		memberships: 0,
		owned_relations: 0,
	});
	expect(
		(
			await runtime.query(
				"select relrowsecurity,relforcerowsecurity from pg_class where oid='public_api_request'::regclass",
			)
		).rows[0],
	).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
});

beforeEach(async () => {
	await cleanupData();
	for (const id of [alice, bob, outsider])
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$1,$2,true)',
			[id, `${id}@example.test`],
		);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Home',$2,'shared'),($3,'Other',$4,'shared')",
		[workspace, alice, hidden, outsider],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner'),($4,$5,$3,'member'),($6,$7,$8,'owner')",
		[
			`${prefix}_owner`,
			alice,
			workspace,
			`${prefix}_member`,
			bob,
			`${prefix}_other`,
			outsider,
			hidden,
		],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Existing','a0')",
		[taskList, workspace, alice],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Task','a0')",
		[task, taskList],
	);
	const pat = await createPersonalAccessToken(runtime, alice, {
		name: "list writer",
		access: "write",
	});
	token = pat.token;
	tokenId = pat.id;
	bobToken = (
		await createPersonalAccessToken(runtime, bob, {
			name: "list writer",
			access: "write",
		})
	).token;
});

afterAll(async () => {
	const failures = await collectCleanup([
		cleanupData,
		() => runtime.end(),
		async () => {
			if (createdRole) await admin.query(`drop owned by "${role}"`);
		},
		async () => {
			if (createdRole) await admin.query(`drop role "${role}"`);
		},
		async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int as count from pg_roles where rolname=$1",
						[role],
					)
				).rows[0].count,
			).toBe(0);
		},
		async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int as count from pg_stat_activity where usename=$1",
						[role],
					)
				).rows[0].count,
			).toBe(0);
		},
		() => admin.end(),
		async () => {
			if (directory) await rm(directory, { recursive: true, force: true });
		},
		async () => {
			vi.unstubAllEnvs();
		},
	]);
	finishCleanup(failures);
});

function send(
	path: string,
	method: string,
	input?: unknown,
	key: string = randomUUID(),
	secret = token,
) {
	return app.handle(
		new Request(`http://localhost/api/v1/${path}`, {
			method,
			headers: {
				authorization: `Bearer ${secret}`,
				"content-type": "application/json",
				"idempotency-key": key,
			},
			...(input === undefined ? {} : { body: JSON.stringify(input) }),
		}),
	);
}

async function observation(secret = token) {
	const response = await send(
		`lists/${taskList}/deletion-observation`,
		"GET",
		undefined,
		randomUUID(),
		secret,
	);
	expect(response.status).toBe(200);
	return apiListDeletionObservationSchema.parse((await response.json()).data);
}

async function input(cascadeTasks = true, secret = token) {
	const observed = await observation(secret);
	return {
		workspaceId: workspace,
		expectedState: observed.stateToken,
		expectedTasksState: observed.tasksState,
		cascadeTasks,
	};
}
const request = (body: unknown, key = randomUUID(), secret = token) =>
	send(`lists/${taskList}`, "DELETE", body, key, secret);
async function acknowledgement(response: Response) {
	expect(response.status).toBe(200);
	return apiListDeleteAckSchema.parse((await response.json()).data);
}
async function receiptCount() {
	return (
		await admin.query(
			"select count(*)::int n from public_api_request where user_id=any($1::text[])",
			[[alice, bob]],
		)
	).rows[0].n;
}
async function waitForRuntimeLock(queryPrefix: string) {
	const deadline = Date.now() + 750;
	while (Date.now() < deadline) {
		const waiting = await admin.query(
			"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like $2",
			[role, `${queryPrefix}%`],
		);
		if (waiting.rows[0].n === 1) return;
	}
	throw new Error("Expected request at held authority lock");
}

test("deletes observed tasks child-first and matching replay acknowledges original without deleting replacement", async () => {
	await admin.query(
		"insert into task(id,list_id,parent_id,title,sort_key) values($1,$2,$3,'Child','a1')",
		[`${prefix}_child`, taskList, task],
	);
	const body = await input();
	const key = randomUUID();
	const first = await acknowledgement(await request(body, key));
	expect(first.deletedTasks).toBe(2);
	expect(first.snapshot.ownerId).toBe(alice);
	expect(
		(await admin.query("select id from task where list_id=$1", [taskList]))
			.rowCount,
	).toBe(0);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Replacement','a0')",
		[taskList, hidden, outsider],
	);
	expect(await acknowledgement(await request(body, key))).toEqual(first);
	expect(
		(await admin.query("select title from list where id=$1", [taskList]))
			.rows[0].title,
	).toBe("Replacement");
	expect(await receiptCount()).toBe(1);
});

test("empty positive control, populated no-cascade refusal and more than 256 rows include child and timestamp microseconds", async () => {
	expect((await request(await input(false))).status).toBe(409);
	expect(await receiptCount()).toBe(0);
	await admin.query("delete from task where list_id=$1", [taskList]);
	const empty = await observation();
	expect(empty.tasksState.count).toBe(0);
	await admin.query(
		"insert into task(id,list_id,title,sort_key,created_at) select $1||lpad(i::text,4,'0'),$2,'Task','a0','2026-01-01T00:00:00.000001Z'::timestamptz from generate_series(1,257) i",
		[`${prefix}_page`, taskList],
	);
	const populated = await observation();
	expect(populated.tasksState.count).toBe(257);
	expect(populated.tasksState.token).not.toBe(empty.tasksState.token);
	await admin.query(
		"update task set created_at=created_at+interval '1 microsecond' where id=$1",
		[`${prefix}_page0257`],
	);
	expect((await observation()).tasksState.token).not.toBe(
		populated.tasksState.token,
	);
	const stale = {
		workspaceId: workspace,
		expectedState: populated.stateToken,
		expectedTasksState: populated.tasksState,
		cascadeTasks: true,
	};
	expect((await request(stale)).status).toBe(409);
	expect(
		(await acknowledgement(await request(await input()))).deletedTasks,
	).toBe(257);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Existing','a0')",
		[taskList, workspace, alice],
	);
	expect(
		(await acknowledgement(await request(await input(false)))).deletedTasks,
	).toBe(0);
});

test.each([
	"title='Changed'",
	"notes='Changed'",
	"done=true",
	"has_import_activation=true",
	"due_all_day=true",
	"quantity='2'",
	"unit='kg'",
	"category='Food'",
	"recurrence_relative=true",
	"reminder_time='10:00'",
	"repeat_every_min=5",
	"max_repeats=2",
	"urgent=true",
	"created_at='2026-01-01T00:00:00.000001Z'",
	"sort_key='a1'",
	"priority=3",
	"due_at='2026-01-01T00:00:00.000001Z'",
	"rrule='FREQ=DAILY'",
	"recurrence_anchor_at='2026-01-01T00:00:00.000001Z',recurrence_consumed=1",
	"completed_at='2026-01-01T00:00:00.000001Z'",
])("task field %s invalidates deletion observation", async (change) => {
	const body = await input();
	await admin.query(`update task set ${change} where id=$1`, [task]);
	expect((await request(body)).status).toBe(409);
	expect(await receiptCount()).toBe(0);
	expect(
		(await admin.query("select id from list where id=$1", [taskList])).rowCount,
	).toBe(1);
});

test("current creator authority refuses another Member, permits Admin and refuses captured creator after role loss on replay", async () => {
	const body = await input();
	expect((await request(body, randomUUID(), bobToken)).status).toBe(403);
	await admin.query(
		"update membership set role='admin' where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	const key = randomUUID();
	await acknowledgement(await request(body, key, bobToken));
	await admin.query(
		"update membership set role='member' where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	expect((await request(body, key, bobToken)).status).toBe(403);
});

test.each([
	"revoked_at=now()",
	"access='read'",
])("token %s while waiting is revalidated after native locks", async (change) => {
	const body = await input();
	const holder = await admin.connect();
	await holder.query("begin");
	await holder.query("select id from list where id=$1 for update", [taskList]);
	let pending: Promise<Response> | undefined;
	try {
		pending = request(body);
		await waitForRuntimeLock("select id from list where id =");
		await admin.query(
			`update personal_access_token set ${change} where id=$1`,
			[tokenId],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(
			change.startsWith("revoked") ? 401 : 403,
		);
		expect(await receiptCount()).toBe(0);
	} finally {
		await holder.query("rollback");
		await pending;
		holder.release();
	}
});

test.each([
	"role='viewer'",
	"role='member'",
])("membership %s committed while request waits is current authority", async (change) => {
	await admin.query(
		"update membership set role='admin' where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	const body = await input();
	const holder = await admin.connect();
	await holder.query("begin");
	await holder.query(
		`update membership set ${change} where workspace_id=$1 and user_id=$2`,
		[workspace, bob],
	);
	let pending: Promise<Response> | undefined;
	try {
		pending = request(body, randomUUID(), bobToken);
		await waitForRuntimeLock("select role from membership");
		await holder.query("commit");
		expect((await pending).status).toBe(403);
		expect(await receiptCount()).toBe(0);
	} finally {
		await holder.query("rollback");
		await pending;
		holder.release();
	}
});

test("membership removal while waiting returns 404; simultaneous PAT revocation takes 401 precedence", async () => {
	const body = await input();
	const holder = await admin.connect();
	await holder.query("begin");
	await holder.query(
		"delete from membership where workspace_id=$1 and user_id=$2",
		[workspace, alice],
	);
	let pending: Promise<Response> | undefined;
	try {
		pending = request(body);
		await waitForRuntimeLock("select role from membership");
		await admin.query(
			"update personal_access_token set revoked_at=now() where id=$1",
			[tokenId],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(401);
		expect(await receiptCount()).toBe(0);
	} finally {
		await holder.query("rollback");
		await pending;
		holder.release();
	}
});

test("matching malformed receipt fails closed", async () => {
	const body = await input();
	const key = randomUUID();
	await acknowledgement(await request(body, key));
	await admin.query(
		"update public_api_request set list_snapshot=list_snapshot || jsonb_build_object('extra',true) where user_id=$1 and request_id=$2",
		[alice, key],
	);
	expect((await request(body, key)).status).toBe(500);
});

async function seedFile(
	id: string,
	parentKind = "list",
	parentId = taskList,
	state = "committed",
) {
	await admin.query(
		"insert into workspace_key(id,workspace_id,version,commitment,minted_by) values($1,$2,1,'wdkc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',$3) on conflict do nothing",
		[`${prefix}_key`, workspace, alice],
	);
	await admin.query(
		"insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,observed_bytes,ciphertext_sha256,storage_key,uploaded_by,committed_at) values($1,$2,$3,$4,1,$5,'name','type','dek',4,4,$6,$7,$8,now())",
		[
			id,
			workspace,
			parentKind,
			parentId,
			state,
			"a".repeat(64),
			`${workspace}/${id}/content`,
			alice,
		],
	);
}
test("native cleanup retires committed list/task/comment files, preserves pending transfer, folder/workspace/key and unrelated list", async () => {
	const folder = `${prefix}_folder`,
		sibling = `${prefix}_sibling`,
		comment = `${prefix}_comment`;
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Folder','a0')",
		[folder, workspace],
	);
	await admin.query("update list set folder_id=$1 where id=$2", [
		folder,
		taskList,
	]);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Sibling','a1')",
		[sibling, workspace, alice],
	);
	await admin.query(
		"insert into comment(id,task_id,author_id,body) values($1,$2,$3,'Comment')",
		[comment, task, alice],
	);
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,'pending',1)",
		[task],
	);
	for (const [id, kind, parent, state] of [
		[`${prefix}_list_file`, "list", taskList, "committed"],
		[`${prefix}_task_file`, "task", task, "committed"],
		[`${prefix}_comment_file`, "comment", comment, "committed"],
		[`${prefix}_pending_file`, "list", taskList, "uploading"],
		[`${prefix}_sibling_file`, "list", sibling, "committed"],
	])
		await seedFile(id, kind, parent, state);
	await acknowledgement(await request(await input()));
	expect(
		(
			await admin.query(
				"select id,state from attachment where workspace_id=$1 order by id",
				[workspace],
			)
		).rows,
	).toEqual([
		{ id: `${prefix}_comment_file`, state: "deleting" },
		{ id: `${prefix}_list_file`, state: "deleting" },
		{ id: `${prefix}_pending_file`, state: "uploading" },
		{ id: `${prefix}_sibling_file`, state: "committed" },
		{ id: `${prefix}_task_file`, state: "deleting" },
	]);
	for (const [table, id] of [
		["workspace", workspace],
		["folder", folder],
		["workspace_key", `${prefix}_key`],
		["list", sibling],
	])
		expect(
			(await admin.query(`select id from ${table} where id=$1`, [id])).rowCount,
		).toBe(1);
	expect(
		(await admin.query("select id from comment where id=$1", [comment]))
			.rowCount,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select task_id from task_notification_activation where task_id=$1",
				[task],
			)
		).rowCount,
	).toBe(0);
});

test("BEFORE receipt insertion proves deletion and attachment retirement then failure rolls back everything and permits exact retry", async () => {
	const key = randomUUID(),
		file = `${prefix}_rollback_file`,
		sequence = `${prefix}_proof`,
		fn = `${prefix}_reject`,
		trigger = `${prefix}_reject_trigger`;
	await seedFile(file);
	const body = await input();
	await admin.query(`create sequence "${sequence}"`);
	await admin.query(`grant usage on sequence "${sequence}" to "${role}"`);
	await admin.query(`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin
 if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then
 if exists(select 1 from list where id=new.list_id) or exists(select 1 from task where list_id=new.list_id) or not exists(select 1 from attachment where id=TG_ARGV[2] and state='deleting' and deleted_at is not null) then raise exception 'fixture-delete-not-complete';end if;
 perform nextval(TG_ARGV[3]::regclass);raise exception 'fixture-receipt-failure';end if;return new;end $fixture$`);
	const statement = await admin.query(
		"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text,$6::text) as statement",
		[trigger, fn, alice, key, file, sequence],
	);
	await admin.query(statement.rows[0].statement);
	let active = true;
	try {
		expect((await request(body, key)).status).toBe(500);
		expect(
			(await admin.query(`select last_value::int,is_called from "${sequence}"`))
				.rows[0],
		).toEqual({ last_value: 1, is_called: true });
		expect(
			(await admin.query("select id from list where id=$1", [taskList]))
				.rowCount,
		).toBe(1);
		expect(
			(await admin.query("select id from task where id=$1", [task])).rowCount,
		).toBe(1);
		expect(
			(
				await admin.query(
					"select state,deleted_at from attachment where id=$1",
					[file],
				)
			).rows[0],
		).toEqual({ state: "committed", deleted_at: null });
		expect(await receiptCount()).toBe(0);
		await admin.query(`drop trigger "${trigger}" on public_api_request`);
		active = false;
		await acknowledgement(await request(body, key));
		expect(await receiptCount()).toBe(1);
	} finally {
		if (active)
			await admin.query(`drop trigger "${trigger}" on public_api_request`);
		await admin.query(`drop function "${fn}"()`);
		await admin.query(`drop sequence "${sequence}"`);
	}
});

test.each([
	"lists",
	"tasks",
	"tasks/complete",
	"tasks/update",
	"tasks/delete",
	"lists/update",
])("UUID namespace conflicts in both directions with %s", async (operation) => {
	const deletionBody = await input();
	const taskObserved = await send(`tasks/${task}/deletion-observation`, "GET");
	expect(taskObserved.status).toBe(200);
	const taskState = (await taskObserved.json()).data;
	const path =
		operation === "lists"
			? "lists"
			: operation === "tasks"
				? "tasks"
				: operation.startsWith("lists")
					? `lists/${taskList}`
					: `tasks/${task}${operation === "tasks/complete" ? "/complete" : ""}`;
	const method = operation.endsWith("update")
		? "PATCH"
		: operation.endsWith("delete")
			? "DELETE"
			: "POST";
	const body =
		operation === "lists"
			? { workspaceId: workspace, title: "Created", kind: "tasks" }
			: operation === "tasks"
				? { listId: taskList, title: "Created" }
				: operation === "tasks/complete"
					? { listId: taskList, expectedDueAt: null }
					: operation === "tasks/update"
						? {
								listId: taskList,
								expectedState: taskState.stateToken,
								patch: { title: "Changed" },
							}
						: operation === "tasks/delete"
							? {
									listId: taskList,
									expectedState: taskState.stateToken,
									expectedChildrenState: taskState.childrenState,
									cascadeChildren: false,
								}
							: {
									workspaceId: workspace,
									expectedState: deletionBody.expectedState,
									patch: { title: "Changed" },
								};
	const key = randomUUID();
	const other = await send(path, method, body, key);
	expect([200, 201]).toContain(other.status);
	expect((await request(deletionBody, key)).status).toBe(409);
	const freshDeletion = await input();
	const deleteKey = randomUUID();
	await acknowledgement(await request(freshDeletion, deleteKey));
	// Recreate target resources so the opposite writer reaches its shared receipt check.
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Existing','a0')",
		[taskList, workspace, alice],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Task','a0')",
		[task, taskList],
	);
	expect((await send(path, method, body, deleteKey)).status).toBe(409);
});

test("task fingerprint follows stable C order across physical reinsertion and a fresh identical semantic recreation can match", async () => {
	await admin.query(
		"update task set created_at='2026-01-01T00:00:00.000001Z' where id=$1",
		[task],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Upper','a0'),($3,$2,'Lower','a0')",
		[`${prefix}_Z`, taskList, `${prefix}_a`],
	);
	const observed = await observation();
	const body = await input();
	const rows = (
		await admin.query(
			"select to_jsonb(t) as row from task t where list_id=$1",
			[taskList],
		)
	).rows;
	await admin.query("delete from task where list_id=$1", [taskList]);
	await admin.query("delete from list where id=$1", [taskList]);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Existing','a0')",
		[taskList, workspace, alice],
	);
	for (const { row } of rows.reverse())
		await admin.query(
			"insert into task select (jsonb_populate_record(null::task,$1::jsonb)).*",
			[JSON.stringify(row)],
		);
	expect(await observation()).toEqual(observed);
	await acknowledgement(await request(body));
});

test("actual slow SQL fetch exceeds cumulative scan deadline with no truncated result", async () => {
	await admin.query(
		"insert into task(id,list_id,title,sort_key) select $1||i,$2,'Task','a0' from generate_series(1,257) i",
		[`${prefix}_slow`, taskList],
	);
	const client = await admin.connect();
	await client.query("begin");
	const original = client.query.bind(client);
	let declared = false;
	const spy = vi
		.spyOn(client, "query")
		.mockImplementation((...args: Parameters<typeof client.query>) => {
			if (
				typeof args[0] === "string" &&
				args[0].startsWith("declare api_deletion_tasks")
			) {
				declared = true;
				args[0] = args[0].replace(
					"from task t where",
					"from task t cross join lateral (select pg_sleep(0.03 + length(t.id)*0)) fixture_delay where",
				);
			}
			return original(...args);
		});
	const start = performance.now();
	try {
		await expect(observeDeletionTasks(client, taskList)).rejects.toMatchObject({
			code: "57014",
		});
		expect(declared).toBe(true);
		expect(performance.now() - start).toBeGreaterThan(4500);
		expect(await receiptCount()).toBe(0);
	} finally {
		spy.mockRestore();
		await client.query("rollback");
		client.release();
	}
}, 15000);

const guards: Guards = {
	foreignOrigin: () => false,
	guardedPost:
		(handler) =>
		async ({ request }) =>
			handler(request, { user: { id: alice } } as unknown as Session),
	guardedGet:
		(handler) =>
		async ({ request }) =>
			handler(request, { user: { id: alice } } as unknown as Session),
};
async function uploadingFile() {
	expect(e2eEnabled()).toBe(true);
	const id = `${prefix}_finalize_file`;
	await seedFile(id);
	await admin.query(
		"insert into membership_key(id,membership_id,user_id,workspace_id,key_version,enc,ciphertext,recipient_public_key,granted_by) values($1,$2,$3,$4,1,'enc','cipher','pk',$3)",
		[`${prefix}_grant`, `${prefix}_owner`, alice, workspace],
	);
	const key = `${workspace}/${id}/content`;
	const stored = await store.put(
		key,
		(async function* () {
			yield new Uint8Array([1, 2, 3, 4]);
		})(),
	);
	await admin.query(
		"update attachment set state='uploading',committed_at=null,reservation_expires_at=now()+interval '1 hour',ciphertext_sha256=$1 where id=$2",
		[stored.sha256, id],
	);
	return id;
}
function finalizeFile(id: string) {
	return new Elysia().use(attachmentRoutes(runtime, guards, store)).handle(
		new Request("http://localhost/api/attachments/finalize", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		}),
	);
}
async function blockedAtLeast(count: number) {
	await vi.waitFor(
		async () =>
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
						[role],
					)
				).rows[0].n,
			).toBeGreaterThanOrEqual(count),
		{ timeout: 750, interval: 10 },
	);
}

test("finalize holding list key-share commits before API deletion and its file is retired", async () => {
	const id = await uploadingFile(),
		body = await input(),
		fn = `${prefix}_pause_finalize`,
		trigger = `${prefix}_pause_finalize_trigger`;
	const barrier = await admin.connect();
	const barrierKey = `${prefix}_finalize_barrier`;
	await barrier.query("select pg_advisory_lock(hashtextextended($1,0))", [
		barrierKey,
	]);
	await admin.query(
		`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin if new.id=TG_ARGV[0] and new.state='committed' then perform pg_advisory_xact_lock(hashtextextended(TG_ARGV[1],0));end if;return new;end $fixture$`,
	);
	const statement = await admin.query(
		"select format('create trigger %I before update on attachment for each row execute function %I(%L,%L)',$1::text,$2::text,$3::text,$4::text) as statement",
		[trigger, fn, id, barrierKey],
	);
	await admin.query(statement.rows[0].statement);
	let finalizing: Promise<Response> | undefined,
		deleting: Promise<Response> | undefined;
	try {
		finalizing = finalizeFile(id);
		await blockedAtLeast(1);
		deleting = request(body);
		await blockedAtLeast(2);
		await barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
			barrierKey,
		]);
		expect((await finalizing).status).toBe(200);
		await acknowledgement(await deleting);
		expect(
			(await admin.query("select state from attachment where id=$1", [id]))
				.rows[0].state,
		).toBe("deleting");
	} finally {
		await barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
			barrierKey,
		]);
		await Promise.allSettled([finalizing, deleting]);
		barrier.release();
		await admin.query(`drop trigger "${trigger}" on attachment`);
		await admin.query(`drop function "${fn}"()`);
	}
});

test("API deletion holding list update through receipt makes concurrent finalize abort", async () => {
	const id = await uploadingFile(),
		body = await input(),
		fn = `${prefix}_pause_delete`,
		trigger = `${prefix}_pause_delete_trigger`,
		key = randomUUID(),
		barrierKey = `${prefix}_delete_barrier`;
	const barrier = await admin.connect();
	await barrier.query("select pg_advisory_lock(hashtextextended($1,0))", [
		barrierKey,
	]);
	await admin.query(
		`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then if exists(select 1 from list where id=new.list_id) then raise exception 'fixture-list-not-deleted';end if;perform pg_advisory_xact_lock(hashtextextended(TG_ARGV[2],0));end if;return new;end $fixture$`,
	);
	const statement = await admin.query(
		"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text) as statement",
		[trigger, fn, alice, key, barrierKey],
	);
	await admin.query(statement.rows[0].statement);
	let deleting: Promise<Response> | undefined,
		finalizing: Promise<Response> | undefined;
	try {
		deleting = request(body, key);
		await blockedAtLeast(1);
		finalizing = finalizeFile(id);
		await blockedAtLeast(2);
		await barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
			barrierKey,
		]);
		await acknowledgement(await deleting);
		expect((await finalizing).status).toBe(409);
		expect(
			(await admin.query("select state from attachment where id=$1", [id]))
				.rows[0].state,
		).toBe("aborted");
		expect(await store.exists(`${workspace}/${id}/content`)).toBe(false);
	} finally {
		await barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
			barrierKey,
		]);
		await Promise.allSettled([deleting, finalizing]);
		barrier.release();
		await admin.query(`drop trigger "${trigger}" on public_api_request`);
		await admin.query(`drop function "${fn}"()`);
	}
});

test("retained history ledger and redaction survive native list deletion", async () => {
	const id = `${prefix}_ledger`;
	await admin.query(
		"insert into import_history_ledger(id,collection,target_parent_id,source_namespace,source_row_id,source_row_id_sha256,target_id,content_digest) values($1,'comments',$2,$3,'source-row',$4,$5,$6)",
		[
			id,
			task,
			randomUUID(),
			createHash("sha256").update("source-row").digest("hex"),
			`${prefix}_old_comment`,
			"c".repeat(64),
		],
	);
	await admin.query(
		"insert into import_history_redaction(ledger_id) values($1)",
		[id],
	);
	try {
		await acknowledgement(await request(await input()));
		expect(
			(
				await admin.query("select id from import_history_ledger where id=$1", [
					id,
				])
			).rowCount,
		).toBe(1);
		expect(
			(
				await admin.query(
					"select ledger_id from import_history_redaction where ledger_id=$1",
					[id],
				)
			).rowCount,
		).toBe(1);
	} finally {
		await cleanupLedger(id);
	}
});

async function cleanupLedger(id: string) {
	const cleanup = await admin.connect();
	try {
		await cleanup.query("begin");
		await cleanup.query("set local session_replication_role=replica");
		await cleanup.query(
			"delete from import_history_redaction where ledger_id=$1",
			[id],
		);
		await cleanup.query("delete from import_history_ledger where id=$1", [id]);
		await cleanup.query("commit");
	} catch (error) {
		await cleanup.query("rollback");
		throw error;
	} finally {
		cleanup.release();
	}
}
