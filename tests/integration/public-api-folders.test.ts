import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import {
	apiFolderCreateAckSchema,
	apiFolderDeleteAckSchema,
	apiFolderObservationSchema,
	apiFolderUpdateAckSchema,
} from "../../src/domain/public-api-folder.ts";
import { folderDatabase } from "../../src/server/public-api/folder-write.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_FOLDER_API_TEST_DATABASE ?? "ditero_e2e";
if (
	!databaseURL ||
	process.env.NODE_ENV !== "test" ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error(
		"Dedicated folder API test database and NODE_ENV=test required",
	);
const admin = new Pool({ connectionString: databaseURL });
const prefix = `folder_api_${randomUUID().replaceAll("-", "")}`;
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
const folder = `${prefix}_folder`;

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
		`folders/${folder}/observation`,
		"GET",
		undefined,
		randomUUID(),
		secret,
	);
	expect(response.status).toBe(200);
	return apiFolderObservationSchema.parse((await response.json()).data);
}

async function observedBody(secret = token) {
	return {
		workspaceId: workspace,
		expectedState: (await observation(secret)).stateToken,
	};
}
const create = (body: unknown, key = randomUUID(), secret = token) =>
	send("folders", "POST", body, key, secret);
const rename = (body: unknown, key = randomUUID(), secret = token) =>
	send(`folders/${folder}`, "PATCH", body, key, secret);
const remove = (body: unknown, key = randomUUID(), secret = token) =>
	send(`folders/${folder}`, "DELETE", body, key, secret);
async function countReceipts() {
	return (
		await admin.query(
			"select count(*)::int n from public_api_request where user_id=any($1::text[])",
			[[alice, bob]],
		)
	).rows[0].n;
}
async function waitForLock(queryPrefix: string) {
	const deadline = Date.now() + 750;
	while (Date.now() < deadline) {
		if (
			(
				await admin.query(
					"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and query like $2",
					[role, `${queryPrefix}%`],
				)
			).rows[0].n === 1
		)
			return;
	}
	throw new Error("Expected actual runtime lock wait");
}

test("Member creates, discovers, renames and deletes folders with immutable original acknowledgements", async () => {
	const key = randomUUID();
	const response = await create(
		{ workspaceId: workspace, name: " Projects " },
		key,
		bobToken,
	);
	expect(response.status).toBe(201);
	const ack = apiFolderCreateAckSchema.parse((await response.json()).data);
	expect(ack.snapshot.name).toBe("Projects");
	expect(ack.snapshot.sortKey).not.toBe("a0");
	const page = await send(`folders?workspaceId=${workspace}`, "GET");
	expect(page.status).toBe(200);
	expect(
		(await page.json()).data.map((row: { id: string }) => row.id),
	).toContain(ack.snapshot.id);
	const changeKey = randomUUID();
	const changed = await rename(
		{ ...(await observedBody()), patch: { name: " Renamed " } },
		changeKey,
		bobToken,
	);
	expect(changed.status).toBe(200);
	const changedAck = apiFolderUpdateAckSchema.parse(
		(await changed.json()).data,
	);
	expect(changedAck.snapshot.name).toBe("Renamed");
	const deleteKey = randomUUID(),
		body = await observedBody();
	const deleted = await remove(body, deleteKey, bobToken);
	expect(deleted.status).toBe(200);
	const deleteAck = apiFolderDeleteAckSchema.parse((await deleted.json()).data);
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Replacement','a0')",
		[folder, hidden],
	);
	const replay = await remove(body, deleteKey, bobToken);
	expect(replay.status).toBe(200);
	expect((await replay.json()).data).toEqual(deleteAck);
	expect(
		(await admin.query("select name from folder where id=$1", [folder])).rows[0]
			.name,
	).toBe("Replacement");
	const createdReplay = await create(
		{ workspaceId: workspace, name: "Projects" },
		key,
		bobToken,
	);
	expect(createdReplay.status).toBe(200);
	expect((await createdReplay.json()).data).toEqual(ack);
});

test("read token and Viewer observe but cannot write; inaccessible folders remain 404", async () => {
	const readToken = (
		await createPersonalAccessToken(runtime, bob, { name: "reader" })
	).token;
	expect(
		(
			await send(
				`folders/${folder}/observation`,
				"GET",
				undefined,
				randomUUID(),
				readToken,
			)
		).status,
	).toBe(200);
	expect(
		(
			await create(
				{ workspaceId: workspace, name: "Denied" },
				randomUUID(),
				readToken,
			)
		).status,
	).toBe(403);
	await admin.query(
		"update membership set role='viewer' where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	expect(
		(
			await send(
				`folders/${folder}/observation`,
				"GET",
				undefined,
				randomUUID(),
				bobToken,
			)
		).status,
	).toBe(200);
	expect(
		(await remove(await observedBody(), randomUUID(), bobToken)).status,
	).toBe(403);
	await admin.query(
		"delete from membership where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	expect(
		(await send(`folders/${folder}`, "GET", undefined, randomUUID(), bobToken))
			.status,
	).toBe(404);
});

test("stale scalar state and nonempty folders refuse deletion without changing lists/tasks", async () => {
	const body = await observedBody();
	await admin.query("update folder set name='Changed' where id=$1", [folder]);
	expect((await remove(body)).status).toBe(409);
	await admin.query("update list set folder_id=$1 where id=$2", [
		folder,
		taskList,
	]);
	const response = await remove(await observedBody());
	expect(response.status).toBe(409);
	expect((await response.json()).code).toBe("folder-not-empty");
	expect(await countReceipts()).toBe(0);
	expect(
		(await admin.query("select id from task where id=$1", [task])).rowCount,
	).toBe(1);
	expect(
		(await admin.query("select folder_id from list where id=$1", [taskList]))
			.rows[0].folder_id,
	).toBe(folder);
});

test("changed native rename is activation-gated while unchanged name may be acknowledged", async () => {
	await admin.query("update list set folder_id=$1 where id=$2", [
		folder,
		taskList,
	]);
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,'pending',1)",
		[task],
	);
	const body = await observedBody();
	const refused = await rename({ ...body, patch: { name: "Changed" } });
	expect(refused.status).toBe(409);
	expect((await refused.json()).code).toBe("activation-pending");
	expect(await countReceipts()).toBe(0);
	expect((await rename({ ...body, patch: { name: "Existing" } })).status).toBe(
		200,
	);
});

test.each([
	"revoked_at=now()",
	"access='read'",
])("PAT %s committed while folder lock is held is revalidated", async (change) => {
	const body = await observedBody();
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await holder.query("begin");
		await holder.query("select id from folder where id=$1 for update", [
			folder,
		]);
		pending = remove(body);
		await waitForLock("select id from folder where id =");
		await admin.query(
			`update personal_access_token set ${change} where id=$1`,
			[tokenId],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(
			change.startsWith("revoked") ? 401 : 403,
		);
		expect(await countReceipts()).toBe(0);
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

test("membership removal plus PAT revocation while awaiting membership lock takes 401 precedence", async () => {
	const body = await observedBody();
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await holder.query("begin");
		await holder.query(
			"delete from membership where workspace_id=$1 and user_id=$2",
			[workspace, bob],
		);
		pending = remove(body, randomUUID(), bobToken);
		await waitForLock("select role from membership");
		await admin.query(
			"update personal_access_token set revoked_at=now() where user_id=$1",
			[bob],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(401);
		expect(await countReceipts()).toBe(0);
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

test("historical rename replay never renames replacement and requires current original membership", async () => {
	const body = { ...(await observedBody()), patch: { name: "Changed" } },
		key = randomUUID();
	expect((await rename(body, key, bobToken)).status).toBe(200);
	await admin.query("delete from folder where id=$1", [folder]);
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Replacement','a0')",
		[folder, hidden],
	);
	expect((await rename(body, key, bobToken)).status).toBe(200);
	expect(
		(await admin.query("select name from folder where id=$1", [folder])).rows[0]
			.name,
	).toBe("Replacement");
	await admin.query(
		"update membership set role='viewer' where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	expect((await rename(body, key, bobToken)).status).toBe(403);
});

test("malformed retained folder receipt fails closed", async () => {
	const body = await observedBody(),
		key = randomUUID();
	expect((await remove(body, key)).status).toBe(200);
	await admin.query(
		"update public_api_request set folder_snapshot=folder_snapshot||jsonb_build_object('extra',true) where user_id=$1 and request_id=$2",
		[alice, key],
	);
	expect((await remove(body, key)).status).toBe(500);
});

test.each([
	"create",
	"update",
	"delete",
])("BEFORE receipt trigger proves native %s then forced failure rolls back and exact retry succeeds", async (mode) => {
	const key = randomUUID(),
		sequence = `${prefix}_proof`,
		fn = `${prefix}_reject_fn`,
		trigger = `${prefix}_reject_trigger`;
	const body =
		mode === "create"
			? { workspaceId: workspace, name: "Created" }
			: mode === "update"
				? { ...(await observedBody()), patch: { name: "Changed" } }
				: await observedBody();
	const perform = () =>
		mode === "create"
			? create(body, key)
			: mode === "update"
				? rename(body, key)
				: remove(body, key);
	await admin.query(`create sequence "${sequence}"`);
	await admin.query(`grant usage on sequence "${sequence}" to "${role}"`);
	await admin.query(`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin
 if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then
 if new.resource_kind<>'folder' then raise exception 'fixture-wrong-resource';end if;
 if TG_ARGV[2]='delete' then if exists(select 1 from folder where id=new.folder_id) then raise exception 'fixture-native-delete-not-complete';end if;
 else if not exists(select 1 from folder where id=new.folder_id and name=case TG_ARGV[2] when 'create' then 'Created' else 'Changed' end) then raise exception 'fixture-native-write-not-complete';end if;end if;
 perform nextval(TG_ARGV[3]::regclass);raise exception 'fixture-receipt-failure';end if;return new;end $fixture$`);
	const statement = await admin.query(
		"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text,$6::text) as statement",
		[trigger, fn, alice, key, mode, sequence],
	);
	await admin.query(statement.rows[0].statement);
	let active = true;
	try {
		expect((await perform()).status).toBe(500);
		expect(
			(await admin.query(`select last_value::int,is_called from "${sequence}"`))
				.rows[0],
		).toEqual({ last_value: 1, is_called: true });
		expect(await countReceipts()).toBe(0);
		expect(
			(await admin.query("select name from folder where id=$1", [folder]))
				.rows[0].name,
		).toBe("Existing");
		expect(
			(
				await admin.query(
					"select id from folder where workspace_id=$1 and name='Created'",
					[workspace],
				)
			).rowCount,
		).toBe(0);
		await admin.query(`drop trigger "${trigger}" on public_api_request`);
		active = false;
		expect((await perform()).status).toBe(mode === "create" ? 201 : 200);
		expect(await countReceipts()).toBe(1);
	} finally {
		finishCleanup(
			await collectCleanup([
				async () => {
					if (active)
						await admin.query(
							`drop trigger "${trigger}" on public_api_request`,
						);
				},
				() => admin.query(`drop function "${fn}"()`),
				() => admin.query(`drop sequence "${sequence}"`),
			]),
		);
	}
});

test("list insertion committed before empty-delete folder lock is refused without orphaning", async () => {
	const body = await observedBody();
	const holder = await runtime.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await holder.query("begin");
		await holder.query("select set_config('ditero.user_id',$1,true)", [bob]);
		await holder.query(
			"insert into list(id,workspace_id,owner_id,title,sort_key,folder_id) values($1,$2,$3,'Child','a1',$4)",
			[`${prefix}_child_list`, workspace, bob, folder],
		);
		pending = remove(body);
		await waitForLock("select id from folder where id =");
		await holder.query("commit");
		const response = await pending;
		expect(response.status).toBe(409);
		expect((await response.json()).code).toBe("folder-not-empty");
		expect(
			(
				await admin.query("select folder_id from list where id=$1", [
					`${prefix}_child_list`,
				])
			).rows[0].folder_id,
		).toBe(folder);
		expect(await countReceipts()).toBe(0);
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

test("empty-delete holding folder update lock makes a concurrent native list insertion fail its FK", async () => {
	const body = await observedBody(),
		key = randomUUID(),
		fn = `${prefix}_pause_fn`,
		trigger = `${prefix}_pause_trigger`,
		barrierKey = `${prefix}_barrier`;
	const barrier = await admin.connect();
	let deleting: Promise<Response> | undefined,
		creating: Promise<unknown> | undefined;
	const failures: unknown[] = [];
	let activeTrigger = false,
		activeFunction = false;
	try {
		await barrier.query("select pg_advisory_lock(hashtextextended($1,0))", [
			barrierKey,
		]);
		await admin.query(
			`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then if exists(select 1 from folder where id=new.folder_id) then raise exception 'fixture-delete-not-complete';end if;perform pg_advisory_xact_lock(hashtextextended(TG_ARGV[2],0));end if;return new;end $fixture$`,
		);
		activeFunction = true;
		const statement = await admin.query(
			"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text) as statement",
			[trigger, fn, alice, key, barrierKey],
		);
		await admin.query(statement.rows[0].statement);
		activeTrigger = true;
		deleting = remove(body, key);
		await waitForLock("insert into public_api_request");
		const writer = await runtime.connect();
		creating = (async () => {
			const writerFailures: unknown[] = [];
			try {
				await writer.query("begin");
				await folderDatabase(writer).transaction((tx) =>
					withZeroUserContext(tx, bob, () =>
						mutators.list.create.fn({
							tx,
							ctx: { id: bob },
							args: {
								id: `${prefix}_racing_list`,
								workspaceId: workspace,
								title: "Race",
								sortKey: "a1",
								kind: "tasks",
								folderId: folder,
							},
						}),
					),
				);
				await writer.query("commit");
			} catch (error) {
				writerFailures.push(error);
			} finally {
				writerFailures.push(
					...(await releaseLockedClient(
						writer,
						() => writer.query("rollback"),
						[],
					)),
				);
				finishCleanup(writerFailures);
			}
		})();
		const outcome = creating.then(
			() => ({ ok: true as const }),
			(error) => ({ ok: false as const, error }),
		);
		await vi.waitFor(
			async () =>
				expect(
					(
						await admin.query(
							"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
							[role],
						)
					).rows[0].n,
				).toBeGreaterThanOrEqual(2),
			{ timeout: 750, interval: 10 },
		);
		await barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
			barrierKey,
		]);
		expect((await deleting).status).toBe(200);
		const result = await outcome;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "23503" });
		expect(
			(
				await admin.query("select id from list where id=$1", [
					`${prefix}_racing_list`,
				])
			).rowCount,
		).toBe(0);
	} catch (error) {
		failures.push(error);
	} finally {
		failures.push(
			...(await releaseLockedClient(
				barrier,
				() =>
					barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
						barrierKey,
					]),
				[
					async () => deleting,
					async () => {
						try {
							await creating;
						} catch (error) {
							// The expected FK refusal was asserted above; retain every other failure.
							if (
								error &&
								typeof error === "object" &&
								"code" in error &&
								error.code === "23503"
							)
								return;
							throw error;
						}
					},
				],
			)),
		);
		failures.push(
			...(await collectCleanup([
				async () => {
					if (activeTrigger)
						await admin.query(
							`drop trigger "${trigger}" on public_api_request`,
						);
				},
				async () => {
					if (activeFunction) await admin.query(`drop function "${fn}"()`);
				},
			])),
		);
		finishCleanup(failures);
	}
});

test.each([
	"lists",
	"tasks",
	"complete-task",
	"update-task",
	"delete-task",
	"folder-create",
	"folder-update",
])("account UUID collision in both directions with %s", async (operation) => {
	const taskObservation = await send(
		`tasks/${task}/deletion-observation`,
		"GET",
	);
	expect(taskObservation.status).toBe(200);
	const observed = (await taskObservation.json()).data;
	const deletionBody = await observedBody();
	const path =
		operation === "lists"
			? "lists"
			: operation === "tasks"
				? "tasks"
				: operation === "folder-create"
					? "folders"
					: operation === "folder-update"
						? `folders/${folder}`
						: `tasks/${task}${operation === "complete-task" ? "/complete" : ""}`;
	const method =
		operation.startsWith("update") || operation === "folder-update"
			? "PATCH"
			: operation === "delete-task"
				? "DELETE"
				: "POST";
	const body =
		operation === "lists"
			? { workspaceId: workspace, title: "Created", kind: "tasks" }
			: operation === "tasks"
				? { listId: taskList, title: "Created" }
				: operation === "complete-task"
					? { listId: taskList, expectedDueAt: null }
					: operation === "update-task"
						? {
								listId: taskList,
								expectedState: observed.stateToken,
								patch: { title: "Changed" },
							}
						: operation === "delete-task"
							? {
									listId: taskList,
									expectedState: observed.stateToken,
									expectedChildrenState: observed.childrenState,
									cascadeChildren: false,
								}
							: operation === "folder-create"
								? { workspaceId: workspace, name: "New" }
								: { ...deletionBody, patch: { name: "Changed" } };
	const key = randomUUID();
	expect([200, 201]).toContain((await send(path, method, body, key)).status);
	expect((await remove(deletionBody, key)).status).toBe(409);
	const fresh = await observedBody(),
		deleteKey = randomUUID();
	expect((await remove(fresh, deleteKey)).status).toBe(200);
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Existing','a0')",
		[folder, workspace],
	);
	if (operation === "delete-task")
		await admin.query(
			"insert into task(id,list_id,title,sort_key) values($1,$2,'Task','a0')",
			[task, taskList],
		);
	expect((await send(path, method, body, deleteKey)).status).toBe(409);
});

test("receipt check preserves legacy task/list validity while rejecting mixed folder resource columns", async () => {
	const insert = (
		kind: string,
		taskId: string | null,
		listId: string | null,
		listSnapshot: unknown,
		folderId: string | null,
		folderSnapshot: unknown,
	) =>
		admin.query(
			"insert into public_api_request(user_id,request_id,request_hash,resource_kind,task_id,list_id,list_snapshot,folder_id,folder_snapshot) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb)",
			[
				alice,
				randomUUID(),
				"a".repeat(64),
				kind,
				taskId,
				listId,
				listSnapshot === null ? null : JSON.stringify(listSnapshot),
				folderId,
				folderSnapshot === null ? null : JSON.stringify(folderSnapshot),
			],
		);
	await insert("task", "opaque-task", null, null, null, null);
	await insert("list", null, "opaque-list", { id: "opaque-list" }, null, null);
	await insert("folder", null, null, null, "opaque-folder", {
		id: "opaque-folder",
	});
	for (const tuple of [
		["task", null, null, null, null, null],
		["task", "t", "l", { id: "l" }, null, null],
		["task", "t", null, null, "f", { id: "f" }],
		["list", null, "l", { id: "wrong" }, null, null],
		["list", "t", "l", { id: "l" }, null, null],
		["list", null, "l", { id: "l" }, "f", { id: "f" }],
		["folder", "t", null, null, "f", { id: "f" }],
		["folder", null, "l", { id: "l" }, "f", { id: "f" }],
		["folder", null, null, null, "f", { id: "wrong" }],
		["folder", null, null, null, "f", null],
		["other", null, null, null, "f", { id: "f" }],
	] as const)
		await expect(
			insert(tuple[0], tuple[1], tuple[2], tuple[3], tuple[4], tuple[5]),
		).rejects.toMatchObject({ code: "23514" });
	expect(await countReceipts()).toBe(3);
});

test("strict folder endpoints refuse query, media, extra fields and complete UTF-8 bodies above 4 KiB", async () => {
	expect(
		(await create({ workspaceId: workspace, name: "Valid", sortKey: "a1" }))
			.status,
	).toBe(400);
	expect(
		(await remove({ ...(await observedBody()), cascade: true })).status,
	).toBe(400);
	expect(
		(
			await send("folders?workspaceId=workspace", "POST", {
				workspaceId: workspace,
				name: "Valid",
			})
		).status,
	).toBe(400);
	const wrongMedia = await app.handle(
		new Request("http://localhost/api/v1/folders", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "text/plain",
				"idempotency-key": randomUUID(),
			},
			body: JSON.stringify({ workspaceId: workspace, name: "Valid" }),
		}),
	);
	expect(wrongMedia.status).toBe(415);
	const large = await app.handle(
		new Request("http://localhost/api/v1/folders", {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"idempotency-key": randomUUID(),
			},
			body:
				JSON.stringify({ workspaceId: workspace, name: "Valid" }) +
				" ".repeat(4096),
		}),
	);
	expect(large.status).toBe(413);
	expect(await countReceipts()).toBe(0);
});
