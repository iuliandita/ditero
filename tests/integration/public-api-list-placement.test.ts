import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import {
	apiListObservationSchema,
	apiListUpdateAckSchema,
} from "../../src/domain/public-api-list-update.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_LIST_PLACEMENT_TEST_DATABASE ?? "ditero_e2e";
if (
	!databaseURL ||
	process.env.NODE_ENV !== "test" ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error(
		"Dedicated list placement test database and NODE_ENV=test required",
	);
const admin = new Pool({ connectionString: databaseURL });
const prefix = `list_placement_${randomUUID().replaceAll("-", "")}`;
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
let bobToken: string;
let createdRole = false;
const folder = `${prefix}_folder`;
const otherFolder = `${prefix}_other_folder`;
const foreignFolder = `${prefix}_foreign_folder`;

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
async function releaseLockedClient(
	client: PoolClient,
	unlock: () => Promise<unknown>,
	pending: (() => Promise<unknown>)[],
): Promise<unknown[]> {
	const failures: unknown[] = [];
	let destroy = false;
	try {
		await unlock();
	} catch (error) {
		destroy = true;
		failures.push(error);
	} finally {
		try {
			client.release(destroy);
		} catch (error) {
			failures.push(error);
		}
	}
	failures.push(...(await collectCleanup(pending)));
	return failures;
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
	).toBe(expectedDatabase);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from drizzle.__drizzle_migrations",
			)
		).rows[0].count,
	).toBe(journal.entries.length);
	expect(
		(
			await admin.query(
				"select count(*)::int n from information_schema.columns where table_schema='public' and table_name='public_api_request' and column_name in ('folder_id','folder_snapshot')",
			)
		).rows[0].n,
	).toBe(2);
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
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Existing','a0')",
		[folder, workspace],
	);
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Other','a1'),($3,$4,'Foreign','a0')",
		[otherFolder, workspace, foreignFolder, hidden],
	);
	const pat = await createPersonalAccessToken(runtime, alice, {
		name: "list writer",
		access: "write",
	});
	token = pat.token;
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
	]);
	finishCleanup(failures);
});

function send(
	path: string,
	method: string,
	body?: unknown,
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
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
	);
}
async function observed(secret = token) {
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
async function input<P>(patch: P, secret = token) {
	return {
		workspaceId: workspace,
		expectedState: (await observed(secret)).stateToken,
		patch,
	};
}
const update = (body: unknown, key = randomUUID(), secret = token) =>
	send(`lists/${taskList}`, "PATCH", body, key, secret);
async function ack(response: Response) {
	expect(response.status).toBe(200);
	return apiListUpdateAckSchema.parse((await response.json()).data);
}
async function current() {
	return (await observed()).snapshot;
}
async function receipts() {
	return (
		await admin.query(
			"select count(*)::int n from public_api_request where user_id=any($1::text[])",
			[[alice, bob]],
		)
	).rows[0].n;
}
async function waitForLock(queryPrefix: string) {
	await vi.waitFor(
		async () =>
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like $2",
						[role, `${queryPrefix}%`],
					)
				).rows[0].n,
			).toBe(1),
		{ timeout: 750, interval: 10 },
	);
}

test.each([
	{ folderId: "target" },
	{ folderId: null },
	{ sortKey: "a1xyz" },
	{ folderId: "target", sortKey: "a1xyz", title: "Moved" },
])("native member placement changes only requested list scalars %j", async (patch) => {
	if (patch.folderId === null)
		await admin.query("update list set folder_id=$1 where id=$2", [
			folder,
			taskList,
		]);
	const original = await observed();
	const tasks = (
		await admin.query("select row_to_json(t) data from task t where id=$1", [
			task,
		])
	).rows;
	const folders = (
		await admin.query(
			"select row_to_json(f) data from folder f where workspace_id=$1 order by id",
			[workspace],
		)
	).rows;
	const body = await input(
		{
			...patch,
			...(patch.folderId === "target" ? { folderId: otherFolder } : {}),
		},
		bobToken,
	);
	const result = await ack(await update(body, randomUUID(), bobToken));
	expect(result.snapshot).toEqual({ ...original.snapshot, ...body.patch });
	expect(await current()).toEqual(result.snapshot);
	expect(await receipts()).toBe(1);
	expect(
		(
			await admin.query("select row_to_json(t) data from task t where id=$1", [
				task,
			])
		).rows,
	).toEqual(tasks);
	expect(
		(
			await admin.query(
				"select row_to_json(f) data from folder f where workspace_id=$1 order by id",
				[workspace],
			)
		).rows,
	).toEqual(folders);
});
test.each([
	"missing",
	"foreign",
	"visible-foreign",
])("initial %s target is nonenumerating 404 with no effects", async (kind) => {
	if (kind === "visible-foreign")
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'member')",
			[`${prefix}_visible`, alice, hidden],
		);
	const body = await input({
		folderId: kind === "missing" ? `${prefix}_missing` : foreignFolder,
	});
	const original = await current();
	const response = await update(body);
	expect(response.status).toBe(404);
	expect(await response.json()).toMatchObject({ code: "not-found" });
	expect(await current()).toEqual(original);
	expect(await receipts()).toBe(0);
});
test.each([
	"folderId",
	"sortKey",
])("stale %s observation refuses without rebase", async (field) => {
	const body = await input({ folderId: otherFolder, sortKey: "a1xyz" });
	await admin.query(
		field === "folderId"
			? "update list set folder_id=$1 where id=$2"
			: "update list set sort_key=$1 where id=$2",
		[field === "folderId" ? folder : "a2", taskList],
	);
	const response = await update(body);
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: "list-state-changed" });
	expect(await receipts()).toBe(0);
});
test("same-key concurrent requests share one immutable effect; different keys cannot rebase", async () => {
	const body = await input({ folderId: folder, sortKey: "a1xyz" });
	const key = randomUUID();
	const responses = await Promise.all([update(body, key), update(body, key)]);
	const first = await ack(responses[0]);
	expect(await ack(responses[1])).toEqual(first);
	expect(await receipts()).toBe(1);
	expect((await update(body)).status).toBe(409);
	expect(
		(await update({ ...body, patch: { folderId: null } }, key)).status,
	).toBe(409);
	expect(await receipts()).toBe(1);
});
test("original replay ignores target deletion and foreign recreation of folder and list", async () => {
	const body = await input({ folderId: folder, sortKey: "a1xyz" });
	const key = randomUUID();
	const original = await ack(await update(body, key));
	await admin.query("update list set folder_id=null where id=$1", [taskList]);
	await admin.query("delete from folder where id=$1", [folder]);
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Replacement','a0')",
		[folder, hidden],
	);
	expect(await ack(await update(body, key))).toEqual(original);
	expect((await current()).folderId).toBe(null);
	await admin.query("delete from task where id=$1", [task]);
	await admin.query("delete from list where id=$1", [taskList]);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Replacement','a0')",
		[taskList, hidden, outsider],
	);
	expect(await ack(await update(body, key))).toEqual(original);
	expect(
		(
			await admin.query(
				"select workspace_id,folder_id,sort_key,title from list where id=$1",
				[taskList],
			)
		).rows[0],
	).toEqual({
		workspace_id: hidden,
		folder_id: null,
		sort_key: "a0",
		title: "Replacement",
	});
});
test.each([
	"pending",
	"blocked",
])("%s import refuses placement changes but accepts unchanged state and replay", async (status) => {
	const body = await input({ folderId: folder, sortKey: "a1xyz" });
	const key = randomUUID();
	const original = await ack(await update(body, key));
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,$2,1)",
		[task, status],
	);
	expect(await ack(await update(body, key))).toEqual(original);
	const response = await update(await input({ folderId: null }));
	expect(response.status).toBe(409);
	expect(await response.json()).toMatchObject({ code: "activation-pending" });
	expect(
		await ack(
			await update(await input({ folderId: folder, sortKey: "a1xyz" })),
		),
	).toEqual(original);
	expect(await receipts()).toBe(2);
});
test.each([
	"viewer",
	"read",
	"nonmember",
	"deleted",
])("%s cannot place a list", async (kind) => {
	const body = await input({ folderId: folder }, bobToken);
	let secret = bobToken;
	if (kind === "viewer")
		await admin.query(
			"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
	if (kind === "read")
		secret = (await createPersonalAccessToken(runtime, bob, { name: "reader" }))
			.token;
	if (kind === "nonmember")
		await admin.query(
			"delete from membership where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
	if (kind === "deleted")
		await admin.query(
			'update "user" set deleted_at=statement_timestamp() where id=$1',
			[bob],
		);
	expect((await update(body, randomUUID(), secret)).status).toBe(
		kind === "deleted" ? 401 : kind === "nonmember" ? 404 : 403,
	);
	expect(await receipts()).toBe(0);
	expect((await current()).folderId).toBe(null);
});
test.each([
	"pat",
	"target-delete",
	"downgrade",
	"remove",
])("canonical held lock %s revalidates authority and target before effects", async (kind) => {
	const body = await input({ folderId: folder }, bobToken);
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await holder.query("begin");
		if (kind === "downgrade" || kind === "remove")
			await holder.query(
				"select id from membership where user_id=$1 and workspace_id=$2 for update",
				[bob, workspace],
			);
		else
			await holder.query("select id from folder where id=$1 for update", [
				folder,
			]);
		pending = update(body, randomUUID(), bobToken);
		await waitForLock(
			kind === "downgrade" || kind === "remove"
				? "select role from membership where workspace_id=$1"
				: "select id from folder where id = $1",
		);
		if (kind === "pat")
			await holder.query(
				"update personal_access_token set revoked_at=statement_timestamp() where user_id=$1",
				[bob],
			);
		if (kind === "target-delete")
			await holder.query("delete from folder where id=$1", [folder]);
		if (kind === "downgrade")
			await holder.query(
				"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
				[bob, workspace],
			);
		if (kind === "remove")
			await holder.query(
				"delete from membership where user_id=$1 and workspace_id=$2",
				[bob, workspace],
			);
		await holder.query("commit");
		expect((await pending).status).toBe(
			kind === "pat"
				? 401
				: kind === "target-delete"
					? 503
					: kind === "downgrade"
						? 403
						: 404,
		);
		expect(await receipts()).toBe(0);
		expect((await current()).folderId).toBe(null);
	} catch (error) {
		failures.push(error);
	} finally {
		failures.push(
			...(await releaseLockedClient(holder, () => holder.query("rollback"), [
				async () => pending,
			])),
		);
		finishCleanup(failures);
	}
});
test.each([
	{ folderId: "" },
	{ folderId: "x".repeat(257) },
	{ sortKey: "a00" },
	{ sortKey: "a0!" },
	{ sortKey: `a0${"1".repeat(255)}` },
])("invalid placement schema has no effects %j", async (patch) => {
	const body = await input(patch);
	expect((await update(body)).status).toBe(400);
	expect(await receipts()).toBe(0);
});
test("actual whitespace-padded request cap rejects before native placement", async () => {
	const body = await input({ folderId: folder });
	const response = await app.handle(
		new Request(`http://localhost/api/v1/lists/${taskList}`, {
			method: "PATCH",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"idempotency-key": randomUUID(),
			},
			body: " ".repeat(4096) + JSON.stringify(body),
		}),
	);
	expect(response.status).toBe(413);
	expect(await receipts()).toBe(0);
	expect((await current()).folderId).toBe(null);
});

test("receipt failure proves native placement happened and rolls it back atomically", async () => {
	const key = randomUUID(),
		body = await input({ folderId: folder, sortKey: "a1xyz" });
	const sequence = `${prefix}_proof`,
		fn = `${prefix}_fn`,
		trigger = `${prefix}_fail`;
	let hasSequence = false,
		hasFunction = false,
		hasTrigger = false;
	const failures: unknown[] = [];
	try {
		await admin.query(`create sequence "${sequence}"`);
		hasSequence = true;
		await admin.query(`grant usage on sequence "${sequence}" to "${role}"`);
		await admin.query(`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin
		if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then
		 if not exists(select 1 from list where id=new.list_id and folder_id=TG_ARGV[2] and sort_key='a1xyz') then raise exception 'fixture-placement-not-complete';end if;
		 perform nextval(TG_ARGV[3]::regclass);raise exception 'fixture-receipt-refused';end if;return new;end $fixture$`);
		hasFunction = true;
		const sql = await admin.query(
			"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text,$6::text) statement",
			[trigger, fn, alice, key, folder, sequence],
		);
		await admin.query(sql.rows[0].statement);
		hasTrigger = true;
		expect(
			(await admin.query(`select is_called from "${sequence}"`)).rows[0]
				.is_called,
		).toBe(false);
		expect((await update(body, key)).status).toBe(500);
		expect(
			(await admin.query(`select last_value::int,is_called from "${sequence}"`))
				.rows[0],
		).toEqual({ last_value: 1, is_called: true });
		expect((await current()).folderId).toBe(null);
		expect((await current()).sortKey).toBe("a0");
		expect(await receipts()).toBe(0);
	} catch (error) {
		failures.push(error);
	} finally {
		failures.push(
			...(await collectCleanup([
				async () => {
					if (hasTrigger)
						await admin.query(
							`drop trigger "${trigger}" on public_api_request`,
						);
				},
				async () => {
					if (hasFunction) await admin.query(`drop function "${fn}"()`);
				},
				async () => {
					if (hasSequence) await admin.query(`drop sequence "${sequence}"`);
				},
			])),
		);
		finishCleanup(failures);
	}
});
test("personal scope placement preserves ownership and workspace", async () => {
	await admin.query("update workspace set kind='personal' where id=$1", [
		workspace,
	]);
	const original = await observed();
	const result = await ack(
		await update(await input({ folderId: folder, sortKey: "a1xyz" })),
	);
	expect(result.snapshot).toMatchObject({
		workspaceId: workspace,
		ownerId: alice,
		folderId: folder,
		sortKey: "a1xyz",
	});
	expect(result.snapshot.kind).toBe(original.snapshot.kind);
});
test.each([
	"expired",
	"revoked",
	"viewer",
	"removed",
])("%s authority refuses original placement replay", async (kind) => {
	const body = await input({ folderId: folder }, bobToken),
		key = randomUUID();
	await ack(await update(body, key, bobToken));
	if (kind === "expired") {
		const expired = await admin.query(
			"update personal_access_token set created_at=statement_timestamp()-interval '2 seconds', expires_at=statement_timestamp()-interval '1 second' where user_id=$1 returning created_at < expires_at and expires_at < statement_timestamp() as expired_lifetime",
			[bob],
		);
		expect(expired.rows).toEqual([{ expired_lifetime: true }]);
	}
	if (kind === "revoked")
		await admin.query(
			"update personal_access_token set revoked_at=statement_timestamp() where user_id=$1",
			[bob],
		);
	if (kind === "viewer")
		await admin.query(
			"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
	if (kind === "removed")
		await admin.query(
			"delete from membership where user_id=$1 and workspace_id=$2",
			[bob, workspace],
		);
	expect((await update(body, key, bobToken)).status).toBe(
		kind === "viewer" ? 403 : kind === "removed" ? 404 : 401,
	);
	expect(await receipts()).toBe(1);
	expect((await current()).folderId).toBe(folder);
});

test("opposing moves by distinct actors preserve native container locking", async () => {
	const second = `${prefix}_second`;
	await admin.query("update list set folder_id=$1 where id=$2", [
		folder,
		taskList,
	]);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key,folder_id) values($1,$2,$3,'Second','a1',$4)",
		[second, workspace, alice, otherFolder],
	);
	const firstBody = await input({ folderId: otherFolder }, bobToken);
	const observationResponse = await send(`lists/${second}/observation`, "GET");
	expect(observationResponse.status).toBe(200);
	const secondState = apiListObservationSchema.parse(
		(await observationResponse.json()).data,
	);
	const secondBody = {
		workspaceId: workspace,
		expectedState: secondState.stateToken,
		patch: { folderId: folder },
	};
	const results = await Promise.all([
		update(firstBody, randomUUID(), bobToken),
		send(`lists/${second}`, "PATCH", secondBody),
	]);
	expect((await ack(results[0])).snapshot.folderId).toBe(otherFolder);
	expect((await ack(results[1])).snapshot.folderId).toBe(folder);
	expect(await receipts()).toBe(2);
	expect(
		(await admin.query("select list_id from task where id=$1", [task])).rows[0]
			.list_id,
	).toBe(taskList);
});
test("chunked 4KiB request cap refuses before placement", async () => {
	const body = await input({ folderId: folder });
	const chunks = [
		new TextEncoder().encode(" ".repeat(4096)),
		new TextEncoder().encode(JSON.stringify(body)),
	];
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks.shift();
			if (chunk) controller.enqueue(chunk);
			else controller.close();
		},
	});
	const init: RequestInit & { duplex: "half" } = {
		method: "PATCH",
		duplex: "half",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"idempotency-key": randomUUID(),
		},
		body: stream,
	};
	const response = await app.handle(
		new Request(`http://localhost/api/v1/lists/${taskList}`, init),
	);
	expect(response.status).toBe(413);
	expect(await receipts()).toBe(0);
	expect((await current()).folderId).toBe(null);
});
