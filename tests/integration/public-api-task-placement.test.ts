import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	apiTaskPlacementAckSchema,
	apiTaskPlacementObservationSchema,
} from "../../src/domain/public-api-task-placement.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `task_place_${randomUUID().replaceAll("-", "")}`;
const role = `${prefix}_runtime`,
	password = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
	max: 4,
});
const app = publicApiRoutes(runtime, async () => true);
const actor = `${prefix}_actor`,
	viewer = `${prefix}_viewer`,
	other = `${prefix}_other`;
const workspace = `${prefix}_workspace`,
	hidden = `${prefix}_hidden`;
const origin = `${prefix}_origin`,
	target = `${prefix}_target`,
	foreign = `${prefix}_foreign`,
	habits = `${prefix}_habits`;
const parent = `${prefix}_parent`,
	child = `${prefix}_child`;
let token: string,
	tokenId: string,
	viewerToken: string,
	roleCreated = false;
async function cleanupData() {
	const failures: unknown[] = [];
	const steps: readonly [string, string[]][] = [
		[
			"delete from task where list_id=any($1::text[]) and parent_id is not null",
			[origin, target, foreign, habits],
		],
		[
			"delete from task where list_id=any($1::text[])",
			[origin, target, foreign, habits],
		],
		[
			"delete from list where workspace_id=any($1::text[])",
			[workspace, hidden],
		],
		[
			"delete from label where workspace_id=any($1::text[])",
			[workspace, hidden],
		],
		[
			"delete from membership where workspace_id=any($1::text[])",
			[workspace, hidden],
		],
		["delete from workspace where id=any($1::text[])", [workspace, hidden]],
		['delete from "user" where id=any($1::text[])', [actor, viewer, other]],
	];
	for (const [sql, ids] of steps)
		try {
			await admin.query(sql, [ids]);
		} catch (error) {
			failures.push(error);
		}
	if (failures.length)
		throw new AggregateError(failures, "owned placement rows cleanup failed");
}

beforeAll(async () => {
	const statement = await admin.query<{ statement: string }>(
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) as statement",
		[role, password],
	);
	await admin.query(statement.rows[0].statement);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(`grant select on all tables in schema public to "${role}"`);
	await admin.query(
		`grant update(id) on "user",workspace,membership,list to "${role}"`,
	);
	await admin.query(`grant update(task_id) on task_assignee to "${role}"`);
	await admin.query(
		`grant insert,update,delete on task,user_pref,personal_access_token,public_api_request,task_notification_activation,task_notification_recipient,reminder_state,notification_outbox to "${role}"`,
	);
	const proof = await runtime.query(
		"select current_user,session_user,rolsuper,rolbypassrls,rolcanlogin,rolinherit,(select count(*)::int from pg_auth_members where member=r.oid) as memberships,(select count(*)::int from pg_class where relowner=r.oid) as owned_relations from pg_roles r where rolname=current_user",
	);
	expect(proof.rows[0]).toEqual({
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
	for (const id of [actor, viewer, other])
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$1,$2,true)',
			[id, `${id}@example.test`],
		);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Home',$2,'shared'),($3,'Hidden',$4,'shared')",
		[workspace, actor, hidden, other],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner'),($4,$5,$3,'viewer'),($6,$7,$8,'owner')",
		[
			`${prefix}_owner`,
			actor,
			workspace,
			`${prefix}_view`,
			viewer,
			`${prefix}_otherseat`,
			other,
			hidden,
		],
	);
	for (const [id, ws, owner, kind] of [
		[origin, workspace, actor, "tasks"],
		[target, workspace, actor, "tasks"],
		[habits, workspace, actor, "habits"],
		[foreign, hidden, other, "tasks"],
	])
		await admin.query(
			"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,$1,$4,'a0')",
			[id, ws, owner, kind],
		);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Parent','a0')",
		[parent, origin],
	);
	await admin.query(
		"insert into task(id,list_id,parent_id,title,sort_key) values($1,$2,$3,'Child','a0')",
		[child, origin, parent],
	);
	const pat = await createPersonalAccessToken(runtime, actor, {
		name: "placement writer",
		access: "write",
	});
	token = pat.token;
	tokenId = pat.id;
	viewerToken = (
		await createPersonalAccessToken(runtime, viewer, {
			name: "viewer",
			access: "write",
		})
	).token;
});
afterAll(async () => {
	const errors: unknown[] = [];
	const phase = async (run: () => Promise<unknown>) => {
		try {
			await run();
		} catch (error) {
			errors.push(error);
		}
	};
	await phase(cleanupData);
	await phase(() => runtime.end());
	if (roleCreated) {
		await phase(() => admin.query(`drop owned by "${role}"`));
		await phase(() => admin.query(`drop role "${role}"`));
	}
	await phase(async () => {
		expect(
			(
				await admin.query(
					"select count(*)::int as count from pg_roles where rolname=$1",
					[role],
				)
			).rows[0].count,
		).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int as count from pg_stat_activity where usename=$1",
					[role],
				)
			).rows[0].count,
		).toBe(0);
		expect(
			(
				await admin.query(
					'select count(*)::int as count from "user" where id=any($1::text[])',
					[[actor, viewer, other]],
				)
			).rows[0].count,
		).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int as count from workspace where id=any($1::text[])",
					[[workspace, hidden]],
				)
			).rows[0].count,
		).toBe(0);
	});
	await phase(() => admin.end());
	if (errors.length)
		throw new AggregateError(errors, "placement fixture cleanup failed");
});
function send(
	path: string,
	method = "GET",
	input?: unknown,
	key = randomUUID(),
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
async function observation(id = parent, secret = token) {
	const response = await send(
		`tasks/${id}/placement-observation`,
		"GET",
		undefined,
		randomUUID(),
		secret,
	);
	expect(response.status).toBe(200);
	return apiTaskPlacementObservationSchema.parse((await response.json()).data);
}
async function input(id = parent, destination = origin) {
	const observed = await observation(id);
	const list = await send(`lists/${destination}/observation`);
	expect(list.status).toBe(200);
	return {
		workspaceId: workspace,
		listId: origin,
		expectedState: observed.stateToken,
		targetListId: destination,
		expectedTargetState: (await list.json()).data.stateToken,
		sortKey: "a1",
		cascadeChildren: destination !== origin,
		expectedChildrenState:
			destination === origin ? null : observed.childrenState,
	};
}
const place = (
	body: unknown,
	key = randomUUID(),
	id = parent,
	secret = token,
) => send(`tasks/${id}/placement`, "PATCH", body, key, secret);
async function rows() {
	return (
		await admin.query(
			"select id,list_id,parent_id,sort_key,title from task where id=any($1::text[]) order by id",
			[[parent, child]],
		)
	).rows;
}
async function receipts() {
	return Number(
		(
			await admin.query(
				"select count(*) from public_api_request where user_id=$1",
				[actor],
			)
		).rows[0].count,
	);
}
test("viewer can observe but cannot place, with no effect or receipt", async () => {
	await observation(parent, viewerToken);
	const before = await rows();
	expect(
		(await place(await input(), randomUUID(), parent, viewerToken)).status,
	).toBe(403);
	expect(await rows()).toEqual(before);
	expect(await receipts()).toBe(0);
});
test("ordering changes only the selected root key and returns actual immutable placement", async () => {
	const response = await place(await input());
	expect(response.status).toBe(200);
	const ack = apiTaskPlacementAckSchema.parse((await response.json()).data);
	expect(ack.snapshot.sortKey).toBe("a1");
	expect(ack.snapshot.parentId).toBe(null);
	expect(ack.movedChildren).toBe(0);
	expect((await rows()).find((r) => r.id === child).sort_key).toBe("a0");
	expect(await receipts()).toBe(1);
});
test("subtask ordering preserves its parent and list", async () => {
	const response = await place(await input(child), randomUUID(), child);
	expect(response.status).toBe(200);
	const ack = apiTaskPlacementAckSchema.parse((await response.json()).data);
	expect(ack.snapshot.parentId).toBe(parent);
	expect(ack.snapshot.task.listId).toBe(origin);
});
test("root relocation cascades exactly the observed child set without changing child key", async () => {
	const response = await place(await input(parent, target));
	expect(response.status).toBe(200);
	const ack = apiTaskPlacementAckSchema.parse((await response.json()).data);
	expect(ack.movedChildren).toBe(1);
	expect(ack.snapshot.task.listId).toBe(target);
	expect(ack.snapshot.list.workspaceId).toBe(workspace);
	expect((await rows()).every((r) => r.list_id === target)).toBe(true);
	expect((await rows()).find((r) => r.id === child).sort_key).toBe("a0");
});
test("an independent subtask relocation refuses atomically", async () => {
	const before = await rows();
	expect(
		(await place(await input(child, target), randomUUID(), child)).status,
	).toBe(400);
	expect(await rows()).toEqual(before);
	expect(await receipts()).toBe(0);
});
test("changed parent sort key refuses a stale observation", async () => {
	const body = await input();
	await admin.query("update task set sort_key='a2' where id=$1", [parent]);
	expect((await place(body)).status).toBe(409);
	expect(await receipts()).toBe(0);
});
test("changed child content refuses relocation even when IDs/count remain identical", async () => {
	const body = await input(parent, target);
	await admin.query("update task set title='Changed child' where id=$1", [
		child,
	]);
	expect((await place(body)).status).toBe(409);
	expect((await rows()).every((r) => r.list_id === origin)).toBe(true);
	expect(await receipts()).toBe(0);
});
test("new child refuses the observed cascade without partial movement", async () => {
	const body = await input(parent, target);
	await admin.query(
		"insert into task(id,list_id,parent_id,title,sort_key) values($1,$2,$3,'Added','a1')",
		[`${prefix}_added`, origin, parent],
	);
	expect((await place(body)).status).toBe(409);
	expect(await receipts()).toBe(0);
});
test("changed target list metadata invalidates its explicit observation", async () => {
	const body = await input(parent, target);
	await admin.query("update list set title='Changed target' where id=$1", [
		target,
	]);
	expect((await place(body)).status).toBe(409);
	expect(await receipts()).toBe(0);
});
test("same-workspace cross-kind relocation refuses without conversion", async () => {
	const body = await input(parent, habits);
	const before = await rows();
	expect((await place(body)).status).toBe(400);
	expect(await rows()).toEqual(before);
	expect(await receipts()).toBe(0);
});
test("hidden target refuses without disclosing its scope", async () => {
	const body = {
		...(await input()),
		targetListId: foreign,
		cascadeChildren: true,
		expectedChildrenState: (await observation()).childrenState,
	};
	expect((await place(body)).status).toBe(404);
	expect(await receipts()).toBe(0);
});
test("exact replay returns the original snapshot and never mutates a recreated task", async () => {
	const body = await input(),
		key = randomUUID();
	const first = await place(body, key);
	expect(first.status).toBe(200);
	const ack = (await first.json()).data;
	await admin.query("delete from task where parent_id=$1", [parent]);
	await admin.query("delete from task where id=$1", [parent]);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Replacement','a9')",
		[parent, origin],
	);
	const replay = await place(body, key);
	expect(replay.status).toBe(200);
	expect((await replay.json()).data).toEqual(ack);
	expect((await rows()).find((r) => r.id === parent).title).toBe("Replacement");
	expect((await rows()).find((r) => r.id === parent).sort_key).toBe("a9");
	expect(await receipts()).toBe(1);
});
test("UUID reuse with a different canonical body conflicts", async () => {
	const body = await input(),
		key = randomUUID();
	expect((await place(body, key)).status).toBe(200);
	expect((await place({ ...body, sortKey: "a2" }, key)).status).toBe(409);
	expect(await receipts()).toBe(1);
});
test("original authority remains required for immutable replay", async () => {
	const body = await input(),
		key = randomUUID();
	expect((await place(body, key)).status).toBe(200);
	await admin.query(
		"update membership set role='viewer' where workspace_id=$1 and user_id=$2",
		[workspace, actor],
	);
	expect((await place(body, key)).status).toBe(403);
	expect(await receipts()).toBe(1);
});
test("malformed/privileged fields fail before effects", async () => {
	const body = await input();
	for (const variant of [
		{ ...body, parentId: null },
		{ ...body, sortKey: "a10" },
		{ ...body, cascadeChildren: true },
	])
		expect((await place(variant)).status).toBe(400);
	expect(await receipts()).toBe(0);
});
test("two different request UUIDs cannot silently rebase one observation", async () => {
	const body = await input();
	const responses = await Promise.all([
		place(body),
		place({ ...body, sortKey: "a2" }),
	]);
	expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
	expect(await receipts()).toBe(1);
});
test("PAT revocation while canonical target lock is held wins before effects", async () => {
	const body = await input(parent, target),
		holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query("select id from list where id=$1 for update", [target]);
		pending = place(body);
		await expect
			.poll(async () =>
				Number(
					(
						await admin.query(
							"select count(*) from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like '%select id from list%'",
							[role],
						)
					).rows[0].count,
				),
			)
			.toBe(1);
		await admin.query(
			"update personal_access_token set revoked_at=statement_timestamp() where id=$1",
			[tokenId],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(401);
		expect((await rows()).every((r) => r.list_id === origin)).toBe(true);
		expect(await receipts()).toBe(0);
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});
test("cursor observation includes children beyond its first 256-row page", async () => {
	await admin.query(
		"insert into task(id,list_id,parent_id,title,sort_key) select $1||g::text,$2,$3,'Paged child','a0' from generate_series(1,256) g",
		[`${prefix}_page_`, origin, parent],
	);
	const body = await input(parent, target);
	expect(body.expectedChildrenState?.count).toBe(257);
	await admin.query(
		"update task set notes='Changed beyond first page' where id=$1",
		[`${prefix}_page_99`],
	);
	expect((await place(body)).status).toBe(409);
	expect(await receipts()).toBe(0);
	expect(
		Number(
			(
				await admin.query("select count(*) from task where list_id=$1", [
					origin,
				])
			).rows[0].count,
		),
	).toBe(258);
});
test.each([
	"pending",
	"blocked",
])("%s child activation blocks the whole relocation", async (status) => {
	const body = await input(parent, target);
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,$2,1)",
		[child, status],
	);
	expect((await place(body)).status).toBe(409);
	expect((await rows()).every((r) => r.list_id === origin)).toBe(true);
	expect(await receipts()).toBe(0);
});
test("relocation preserves recurrence, history, relationships and encrypted attachment/key metadata", async () => {
	await admin.query(
		"update task set rrule='FREQ=DAILY;COUNT=3',due_at='2026-10-04T10:00:00Z',recurrence_anchor_at='2026-10-04T10:00:00Z',recurrence_consumed=1 where id=$1",
		[parent],
	);
	await admin.query(
		"insert into task_completion_event(id,task_id,actor_user_id,recorded_at,origin,action,before_due_all_day,before_done,after_done) values($1,$2,$3,'2026-10-03T10:00:00Z','member_mutation','complete',false,false,true)",
		[randomUUID(), parent, actor],
	);
	await admin.query(
		"insert into label(id,workspace_id,name,color) values($1,$2,'Owned','blue')",
		[`${prefix}_label`, workspace],
	);
	await admin.query(
		"insert into task_label(id,task_id,label_id) values($1,$2,$3)",
		[`${prefix}_task_label`, parent, `${prefix}_label`],
	);
	await admin.query(
		"insert into task_assignee(id,task_id,user_id) values($1,$2,$3)",
		[`${prefix}_assignee`, parent, actor],
	);
	await admin.query(
		"insert into workspace_key(id,workspace_id,version,commitment,minted_by) values($1,$2,1,'synthetic-commitment',$3)",
		[`${prefix}_key`, workspace, actor],
	);
	await admin.query(
		"insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,observed_bytes,ciphertext_sha256,storage_key,uploaded_by) values($1,$2,'task',$3,1,'committed','synthetic-name','synthetic-type','synthetic-wrap',1,1,$4,$1,$5)",
		[`${prefix}_attachment`, workspace, parent, "a".repeat(64), actor],
	);
	const dependent = async () =>
		Promise.all([
			admin.query("select * from task_completion_event where task_id=$1", [
				parent,
			]),
			admin.query("select * from task_label where task_id=$1", [parent]),
			admin.query("select * from task_assignee where task_id=$1", [parent]),
			admin.query("select * from attachment where workspace_id=$1", [
				workspace,
			]),
			admin.query("select * from workspace_key where workspace_id=$1", [
				workspace,
			]),
		]).then((results) => results.map((result) => result.rows));
	const before = await dependent();
	expect(before.every((rows) => rows.length === 1)).toBe(true);
	const response = await place(await input(parent, target));
	expect(response.status).toBe(200);
	expect(await dependent()).toEqual(before);
	const ack = apiTaskPlacementAckSchema.parse((await response.json()).data);
	expect(ack.snapshot.task.rrule).toBe("FREQ=DAILY;COUNT=3");
	expect(ack.snapshot.task.recurrenceConsumed).toBe(1);
});
test("receipt failure after native placement rolls back parent and child effects", async () => {
	const body = await input(parent, target),
		before = await rows();
	const fn = `${prefix}_fail`,
		trigger = `${prefix}_trigger`,
		sequence = `${prefix}_sequence`;
	let fnCreated = false,
		triggerCreated = false,
		sequenceCreated = false;
	const errors: unknown[] = [];
	try {
		await admin.query(`create sequence "${sequence}"`);
		sequenceCreated = true;
		await admin.query(
			`grant usage,select on sequence "${sequence}" to "${role}"`,
		);
		await admin.query(
			`create function "${fn}"() returns trigger language plpgsql as $$ begin if NEW.user_id='${actor}' then if not exists(select 1 from task where id='${parent}' and list_id='${target}' and sort_key='a1') then raise exception 'Native placement premise missing'; end if; perform nextval('${sequence}'); raise exception 'Owned receipt failure' using errcode='23514'; end if; return NEW; end $$`,
		);
		fnCreated = true;
		await admin.query(
			`create trigger "${trigger}" before insert on public_api_request for each row execute function "${fn}"()`,
		);
		triggerCreated = true;
		expect((await place(body)).status).toBe(500);
		expect(
			(await admin.query(`select last_value,is_called from "${sequence}"`))
				.rows[0],
		).toEqual({ last_value: "1", is_called: true });
		expect(await rows()).toEqual(before);
		expect(await receipts()).toBe(0);
	} catch (error) {
		errors.push(error);
	} finally {
		for (const [created, sql] of [
			[triggerCreated, `drop trigger "${trigger}" on public_api_request`],
			[fnCreated, `drop function "${fn}"()`],
			[sequenceCreated, `drop sequence "${sequence}"`],
		] as const)
			if (created)
				try {
					await admin.query(sql);
				} catch (error) {
					errors.push(error);
				}
	}
	if (errors.length)
		throw new AggregateError(errors, "receipt rollback control failed");
});
test.each([
	"expired",
	"deleted-actor",
	"nonmember",
])("%s cannot place an observed task", async (reason) => {
	const body = await input(),
		before = await rows();
	if (reason === "expired")
		await admin.query(
			"update personal_access_token set expires_at=statement_timestamp()-interval '1 second',created_at=statement_timestamp()-interval '2 days' where id=$1",
			[tokenId],
		);
	if (reason === "deleted-actor")
		await admin.query(
			'update "user" set deleted_at=statement_timestamp() where id=$1',
			[actor],
		);
	if (reason === "nonmember")
		await admin.query(
			"delete from membership where user_id=$1 and workspace_id=$2",
			[actor, workspace],
		);
	expect((await place(body)).status).toBe(reason === "nonmember" ? 404 : 401);
	expect(await rows()).toEqual(before);
	expect(await receipts()).toBe(0);
});
test("real LOGIN receipt RLS and typed snapshot constraints reject foreign owner and mismatched task", async () => {
	const response = await place(await input());
	expect(response.status).toBe(200);
	const ack = apiTaskPlacementAckSchema.parse((await response.json()).data);
	const connection = await runtime.connect();
	try {
		for (const [owner, snapshot, code] of [
			[other, ack, "42501"],
			[
				actor,
				{
					...ack,
					snapshot: {
						...ack.snapshot,
						task: { ...ack.snapshot.task, taskId: child },
					},
				},
				"23514",
			],
		] as const) {
			await connection.query("begin");
			await connection.query("select set_config('ditero.user_id',$1,true)", [
				actor,
			]);
			await expect(
				connection.query(
					"insert into public_api_request(user_id,request_id,request_hash,task_id,task_snapshot) values($1,$2,$3,$4,$5::jsonb)",
					[
						owner,
						randomUUID(),
						"a".repeat(64),
						parent,
						JSON.stringify(snapshot),
					],
				),
			).rejects.toMatchObject({ code });
			await connection.query("rollback");
		}
	} finally {
		await connection.query("rollback");
		connection.release();
	}
	expect(await receipts()).toBe(1);
});
