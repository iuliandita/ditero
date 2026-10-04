import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	apiListObservationSchema,
	apiListUpdateAckSchema,
} from "../../src/domain/public-api-list-update.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `list_update_${randomUUID().replaceAll("-", "")}`;
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

async function cleanupData() {
	await admin.query(
		"delete from task where list_id in (select id from list where workspace_id=any($1::text[]))",
		[[workspace, hidden]],
	);
	await admin.query("delete from list where workspace_id=any($1::text[])", [
		[workspace, hidden],
	]);
	await admin.query("delete from folder where workspace_id=any($1::text[])", [
		[workspace, hidden],
	]);
	await admin.query(
		"delete from membership where workspace_id=any($1::text[])",
		[[workspace, hidden]],
	);
	await admin.query("delete from workspace where id=any($1::text[])", [
		[workspace, hidden],
	]);
	await admin.query('delete from "user" where id=any($1::text[])', [
		[alice, bob, outsider],
	]);
}

beforeAll(async () => {
	const statement = await admin.query<{ statement: string }>(
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls', $1::text, $2::text) as statement",
		[role, password],
	);
	await admin.query(statement.rows[0].statement);
	createdRole = true;
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
	try {
		await cleanupData();
	} finally {
		await runtime.end();
		try {
			if (createdRole) {
				await admin.query(`drop owned by "${role}"`);
				await admin.query(`drop role "${role}"`);
			}
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
		} finally {
			await admin.end();
		}
	}
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
		`lists/${taskList}/observation`,
		"GET",
		undefined,
		randomUUID(),
		secret,
	);
	expect(response.status).toBe(200);
	return apiListObservationSchema.parse((await response.json()).data);
}
async function input(patch: unknown = { title: "Changed" }, secret = token) {
	return {
		workspaceId: workspace,
		expectedState: (await observation(secret)).stateToken,
		patch,
	};
}
const request = (body: unknown, key: string = randomUUID(), secret = token) =>
	send(`lists/${taskList}`, "PATCH", body, key, secret);
async function snapshot(response: Response) {
	expect(response.status).toBe(200);
	const envelope = await response.json();
	expect(envelope).toMatchObject({ version: 1, nextCursor: null });
	return apiListUpdateAckSchema.parse(envelope.data).snapshot;
}
async function receiptCount() {
	return (
		await admin.query(
			"select count(*)::int as count from public_api_request where user_id=any($1::text[])",
			[[alice, bob]],
		)
	).rows[0].count;
}
async function current() {
	return (
		await admin.query(
			"select title,icon,completed_display,workspace_id from list where id=$1",
			[taskList],
		)
	).rows[0];
}
async function waitForRuntimeLock(queryPrefix: string) {
	const deadline = Date.now() + 750;
	while (Date.now() < deadline) {
		const waiting = await admin.query<{ count: number }>(
			"select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like $2",
			[role, `${queryPrefix}%`],
		);
		if (waiting.rows[0].count === 1) return;
	}
	throw new Error("Expected the runtime request at its held authority lock");
}

test("member updates another creator's list via native path with immutable scalar defaults", async () => {
	const observed = await observation(bobToken);
	const updated = await snapshot(
		await request(
			await input(
				{ title: " New ", icon: "🛒", completedDisplay: "hide" },
				bobToken,
			),
			randomUUID(),
			bobToken,
		),
	);
	expect(updated).toEqual({
		...observed.snapshot,
		title: "New",
		icon: "🛒",
		completedDisplay: "hide",
	});
	expect(await receiptCount()).toBe(1);
	expect(
		(await admin.query("select owner_id from list where id=$1", [taskList]))
			.rows[0].owner_id,
	).toBe(alice);
});
test("same UUID concurrent normalized requests commit exactly one immutable acknowledgement", async () => {
	const key = randomUUID();
	const body = await input();
	const replies = await Promise.all([
		request({ ...body, patch: { title: " Changed " } }, key),
		request(body, key),
	]);
	const rows = await Promise.all(replies.map(snapshot));
	expect(rows[0]).toEqual(rows[1]);
	expect(await receiptCount()).toBe(1);
	expect(
		(await request({ ...body, patch: { title: "Other" } }, key)).status,
	).toBe(409);
	expect(
		(await request({ ...body, patch: { icon: null, title: "Changed" } }, key))
			.status,
	).toBe(409);
});
test("different UUIDs cannot silently rebase the same observation", async () => {
	const body = await input();
	const replies = await Promise.all([
		request(body),
		request({ ...body, patch: { icon: "star" } }),
	]);
	expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
	expect(await receiptCount()).toBe(1);
});
test("immutable replay survives edit, deletion and foreign-workspace recreation without mutation", async () => {
	const key = randomUUID(),
		body = await input();
	const original = await snapshot(await request(body, key));
	await admin.query("update list set title='Later',icon='star' where id=$1", [
		taskList,
	]);
	expect(await snapshot(await request(body, key))).toEqual(original);
	await admin.query("delete from task where list_id=$1", [taskList]);
	await admin.query("delete from list where id=$1", [taskList]);
	expect(await snapshot(await request(body, key))).toEqual(original);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Replacement','a0')",
		[taskList, hidden, outsider],
	);
	expect(await snapshot(await request(body, key))).toEqual(original);
	expect((await current()).title).toBe("Replacement");
	expect((await send(`lists/${taskList}`, "GET")).status).toBe(404);
	await admin.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[alice, workspace],
	);
	expect((await request(body, key)).status).toBe(404);
	expect((await current()).title).toBe("Replacement");
});
test("viewer/read/nonmember/deleted actor refuse writes and replay; viewers/read may observe", async () => {
	const body = await input({}, bobToken).catch(() => {
		throw new Error("Observation should succeed");
	});
	body.patch = { title: "Changed" };
	const key = randomUUID();
	await snapshot(await request(body, key, bobToken));
	await admin.query(
		"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
		[bob, workspace],
	);
	await observation(bobToken);
	expect((await request(body, key, bobToken)).status).toBe(403);
	expect((await request(body, randomUUID(), bobToken)).status).toBe(403);
	const read = (
		await createPersonalAccessToken(runtime, alice, { name: "reader" })
	).token;
	await observation(read);
	expect((await request(body, randomUUID(), read)).status).toBe(403);
	const other = (
		await createPersonalAccessToken(runtime, outsider, {
			name: "outsider",
			access: "write",
		})
	).token;
	expect(
		(
			await send(
				`lists/${taskList}/observation`,
				"GET",
				undefined,
				randomUUID(),
				other,
			)
		).status,
	).toBe(404);
	expect((await request(body, randomUUID(), other)).status).toBe(404);
	await admin.query('update "user" set deleted_at=now() where id=$1', [alice]);
	expect((await request(body)).status).toBe(401);
});
test.each([
	"title",
	"icon",
	"completed_display",
	"kind",
	"sort_key",
	"owner_id",
	"folder_id",
	"workspace_id",
])("native concurrent %s changes invalidate observation", async (field) => {
	const body = await input();
	const value: unknown = {
		title: "Native",
		icon: "star",
		completed_display: "hide",
		kind: "shopping",
		sort_key: "a1",
		owner_id: bob,
		folder_id: `${prefix}_folder`,
		workspace_id: hidden,
	}[field];
	if (field === "folder_id")
		await admin.query(
			"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Folder','a0')",
			[value, workspace],
		);
	if (field === "workspace_id")
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'member')",
			[`${prefix}_second`, alice, hidden],
		);
	await admin.query(`update list set ${field}=$1 where id=$2`, [
		value,
		taskList,
	]);
	expect((await request(body)).status).toBe(409);
	expect(await receiptCount()).toBe(0);
	if (field === "folder_id") {
		await admin.query("update list set folder_id=null where id=$1", [taskList]);
		await admin.query("delete from folder where id=$1", [value]);
	}
});
test("unchanged patches and scalar ABA intentionally reuse observations", async () => {
	const body = await input({ title: "Existing" });
	const observed = await observation();
	expect(await snapshot(await request(body))).toEqual(observed.snapshot);
	expect((await observation()).stateToken).toBe(observed.stateToken);
	await admin.query("update list set title='Transient' where id=$1", [
		taskList,
	]);
	await admin.query("update list set title='Existing' where id=$1", [taskList]);
	expect((await observation()).stateToken).toBe(observed.stateToken);
	await snapshot(await request({ ...body, patch: { icon: "star" } }));
});
test.each([
	"pending",
	"blocked",
])("%s import blocks changes but permits unchanged patches and immutable replay", async (status) => {
	const body = await input();
	const key = randomUUID();
	const original = await snapshot(await request(body, key));
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,$2,1)",
		[task, status],
	);
	expect(await snapshot(await request(body, key))).toEqual(original);
	const changed = await request(await input({ title: "Blocked" }));
	expect(changed.status).toBe(409);
	expect(await changed.json()).toMatchObject({ code: "activation-pending" });
	await snapshot(await request(await input({ title: "Changed" })));
	expect((await current()).title).toBe("Changed");
	expect(await receiptCount()).toBe(2);
});
test.each([
	"create",
	"complete",
	"update",
	"delete",
])("list metadata and task %s share UUID namespace in both directions", async (operation) => {
	async function taskRequest(key: string) {
		if (operation === "create")
			return send(
				"tasks",
				"POST",
				{ listId: taskList, title: "New task" },
				key,
			);
		if (operation === "complete")
			return send(
				`tasks/${task}/complete`,
				"POST",
				{ listId: taskList, expectedDueAt: null },
				key,
			);
		const observation = await (
			await send(
				`tasks/${task}/${operation === "delete" ? "deletion-observation" : "observation"}`,
				"GET",
			)
		).json();
		return send(
			`tasks/${task}`,
			operation === "update" ? "PATCH" : "DELETE",
			operation === "update"
				? {
						listId: taskList,
						expectedState: observation.data.stateToken,
						patch: { title: "Edited task" },
					}
				: {
						listId: taskList,
						expectedState: observation.data.stateToken,
						expectedChildrenState: observation.data.childrenState,
						cascadeChildren: false,
					},
			key,
		);
	}
	const listKey = randomUUID();
	await snapshot(await request(await input(), listKey));
	expect((await taskRequest(listKey)).status).toBe(409);
	const taskKey = randomUUID();
	expect((await taskRequest(taskKey)).status).toBe(
		operation === "create" ? 201 : 200,
	);
	expect((await request(await input(), taskKey)).status).toBe(409);
	expect(await receiptCount()).toBe(2);
});
test("list creation and metadata update share UUIDs in both directions", async () => {
	const first = randomUUID();
	await snapshot(await request(await input(), first));
	const creation = { workspaceId: workspace, title: "Other", kind: "tasks" };
	expect((await send("lists", "POST", creation, first)).status).toBe(409);
	const second = randomUUID();
	expect((await send("lists", "POST", creation, second)).status).toBe(201);
	expect((await request(await input(), second)).status).toBe(409);
	expect(await receiptCount()).toBe(2);
});
test("strict 4 KiB transport and schema bounds leave no effects", async () => {
	const body = await input();
	for (const invalid of [
		{ ...body, patch: {} },
		{ ...body, patch: { title: "bad\0value" } },
		{ ...body, patch: { completedDisplay: "invalid" } },
		{ ...body, patch: { folderId: null } },
		{ ...body, expectedState: "bad" },
	])
		expect((await request(invalid)).status).toBe(400);
	expect((await request(body, "invalid")).status).toBe(400);
	expect((await request({ ...body, extra: "x".repeat(4096) })).status).toBe(
		413,
	);
	expect((await send(`lists/${taskList}?limit=1`, "PATCH", body)).status).toBe(
		400,
	);
	expect(
		(await send(`lists/${taskList}/observation?limit=1`, "GET")).status,
	).toBe(400);
	for (const [bytes, type, status] of [
		[new Uint8Array([123, 255, 125]), "application/json", 400],
		[JSON.stringify(body), "text/plain", 415],
	] as const) {
		const response = await app.handle(
			new Request(`http://localhost/api/v1/lists/${taskList}`, {
				method: "PATCH",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": type,
					"idempotency-key": randomUUID(),
				},
				body: bytes,
			}),
		);
		expect(response.status).toBe(status);
	}
	expect(await receiptCount()).toBe(0);
	expect((await current()).title).toBe("Existing");
});
test("membership downgrade at observed held SHARE lock refuses pending write", async () => {
	const body = await input({ title: "Changed" }, bobToken);
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query(
			"select id from membership where user_id=$1 and workspace_id=$2 for update",
			[bob, workspace],
		);
		pending = request(body, randomUUID(), bobToken);
		await waitForRuntimeLock("select role from membership");
		await holder.query(
			"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(403);
		expect(await receiptCount()).toBe(0);
		expect((await current()).title).toBe("Existing");
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});
test("PAT revocation during held actor lock is checked after all canonical locks", async () => {
	const body = await input();
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [alice]);
		pending = request(body);
		await waitForRuntimeLock('select id from "user" where id=$1');
		await holder.query(
			"update personal_access_token set revoked_at=statement_timestamp() where id=$1",
			[tokenId],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(401);
		expect(await receiptCount()).toBe(0);
		expect((await current()).title).toBe("Existing");
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});
test("malformed original snapshots fail closed and expired PAT cannot replay", async () => {
	const key = randomUUID(),
		body = await input();
	const original = await snapshot(await request(body, key));
	await admin.query(
		"update public_api_request set list_snapshot=$1::jsonb where user_id=$2 and request_id=$3",
		[JSON.stringify({ ...original, ownerId: 123 }), alice, key],
	);
	expect((await request(body, key)).status).toBe(500);
	await admin.query(
		"update personal_access_token set created_at=statement_timestamp()-interval '2 days',expires_at=statement_timestamp()-interval '1 day' where id=$1",
		[tokenId],
	);
	expect((await request(body, key)).status).toBe(401);
});

test("receipt insertion failure after a proven native list update rolls the whole transaction back", async () => {
	const key = randomUUID();
	const body = await input();
	const sequence = `${prefix}_insert_proof`;
	const trigger = `${prefix}_receipt_failure`;
	const fn = `${prefix}_receipt_failure_fn`;
	let sequenceCreated = false;
	let functionCreated = false;
	let triggerCreated = false;
	try {
		await admin.query(`create sequence "${sequence}"`);
		sequenceCreated = true;
		await admin.query(`grant usage on sequence "${sequence}" to "${role}"`);
		await admin.query(`create function "${fn}"() returns trigger language plpgsql as $fixture$
		begin
			if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then
				if new.resource_kind<>'list' or not exists (
					select 1 from list where id=new.list_id and title='Changed' and workspace_id=TG_ARGV[2]
				) then raise exception 'fixture-list-not-updated'; end if;
				perform nextval(TG_ARGV[3]::regclass);
				raise exception 'fixture-receipt-insertion-failed';
			end if;
			return new;
		end $fixture$`);
		functionCreated = true;
		const statement = await admin.query<{ statement: string }>(
			"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L)', $1::text,$2::text,$3::text,$4::text,$5::text,$6::text) as statement",
			[trigger, fn, alice, key, workspace, sequence],
		);
		await admin.query(statement.rows[0].statement);
		triggerCreated = true;
		expect(
			(await admin.query(`select is_called from "${sequence}"`)).rows[0]
				.is_called,
		).toBe(false);
		const failed = await request(body, key);
		expect(failed.status).toBe(500);
		expect(await failed.json()).toMatchObject({ code: "internal-error" });
		// Sequence advancement survives rollback and occurs only after the trigger sees the updated list.
		expect(
			(await admin.query(`select last_value::int,is_called from "${sequence}"`))
				.rows[0],
		).toEqual({ last_value: 1, is_called: true });
		expect(await receiptCount()).toBe(0);
		expect((await current()).title).toBe("Existing");
		await admin.query(`drop trigger "${trigger}" on public_api_request`);
		triggerCreated = false;
		expect((await request(body, key)).status).toBe(200);
		expect(await receiptCount()).toBe(1);
		expect((await current()).title).toBe("Changed");
	} finally {
		if (triggerCreated)
			await admin.query(`drop trigger "${trigger}" on public_api_request`);
		if (functionCreated) await admin.query(`drop function "${fn}"()`);
		if (sequenceCreated) await admin.query(`drop sequence "${sequence}"`);
	}
});

test("identical list recreation may intentionally match an old semantic observation", async () => {
	const observed = await observation();
	const body = {
		workspaceId: workspace,
		expectedState: observed.stateToken,
		patch: { title: "Recreated edit" },
	};
	await admin.query("delete from task where list_id=$1", [taskList]);
	await admin.query("delete from list where id=$1", [taskList]);
	const row = observed.snapshot;
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,icon,folder_id,sort_key,completed_display) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
		[
			row.id,
			row.workspaceId,
			row.ownerId,
			row.title,
			row.kind,
			row.icon,
			row.folderId,
			row.sortKey,
			row.completedDisplay,
		],
	);
	expect((await observation()).stateToken).toBe(observed.stateToken);
	expect((await snapshot(await request(body))).title).toBe("Recreated edit");
});
test("membership removal during held workspace lock blocks original authority", async () => {
	const body = await input({ title: "Changed" }, bobToken);
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query("select id from workspace where id=$1 for update", [
			workspace,
		]);
		pending = request(body, randomUUID(), bobToken);
		await waitForRuntimeLock("select id from workspace");
		await holder.query(
			"delete from membership where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(404);
		expect(await receiptCount()).toBe(0);
		expect((await current()).title).toBe("Existing");
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});
