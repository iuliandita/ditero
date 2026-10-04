import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
	vi,
} from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import {
	apiTaskRelationshipObservationSchema,
	apiTaskRelationshipsAckSchema,
} from "../../src/domain/public-api-task-relationships.ts";
import type { CollectedEvent } from "../../src/server/notifications/events.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { visibleTaskRelationships } from "../../src/server/public-api/task-relationship-observation.ts";
import { relationshipDatabase } from "../../src/server/public-api/task-relationship-write.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_TASK_RELATIONSHIP_TEST_DATABASE ?? "ditero_e2e";
if (
	!databaseURL ||
	process.env.NODE_ENV !== "test" ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error(
		"Dedicated task relationship test database and NODE_ENV=test required",
	);
const admin = new Pool({ connectionString: databaseURL });
const prefix = `task_relationship_${randomUUID().replaceAll("-", "")}`;
const role = `${prefix}_runtime`;
const password = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
});
const flushed: CollectedEvent[][] = [];
const app = publicApiRoutes(
	runtime,
	async () => true,
	async (events) => {
		expect(
			(
				await admin.query(
					"select count(*)::int n from public_api_request where user_id=any($1::text[])",
					[[alice, bob]],
				)
			).rows[0].n,
		).toBeGreaterThan(0);
		flushed.push(events);
	},
);
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
const red = `${prefix}_red`,
	blue = `${prefix}_blue`,
	foreignLabel = `${prefix}_foreign`;

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
				admin.query("delete from label where workspace_id=any($1::text[])", [
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

let deferredCleanup: (() => Promise<void>) | undefined;
let deferredCleanupPromise: Promise<void> | undefined;
function awaitDeferredCleanup(): Promise<void> {
	if (!deferredCleanupPromise && deferredCleanup) {
		const cleanup = deferredCleanup;
		deferredCleanupPromise = Promise.resolve().then(cleanup);
	}
	return deferredCleanupPromise ?? Promise.resolve();
}

const overflowCase =
	"complete observation crosses cursor pages and explicitly refuses excessive evidence without truncation";
let overflowSetupPromise: Promise<void> | undefined;
let overflowBehaviorPromise: Promise<void> | undefined;
let overflowPositiveObservation:
	| Awaited<ReturnType<typeof observation>>
	| undefined;
function registerOverflowCleanup(): void {
	const cleanupIndex = `${prefix}_lc`;
	let createdIndex = false;
	const failures: unknown[] = [];
	deferredCleanup = async () => {
		await overflowSetupPromise?.catch((error) => failures.push(error));
		await overflowBehaviorPromise?.catch((error) => failures.push(error));
		// Teardown starts after behavior settles, even if its test timer expires.
		failures.push(
			...(await collectCleanup([
				async () => {
					await admin.query(
						`create index "${cleanupIndex}" on task_label(label_id)`,
					);
					createdIndex = true;
				},
				() =>
					admin.query(
						"delete from task_label where task_id=$1 and label_id in (select $2||g from generate_series(1,50000) g)",
						[task, `${prefix}_overflow`],
					),
				async () => {
					const result = await admin.query(
						"delete from label where workspace_id=$1 and id in (select $2||g from generate_series(1,50000) g)",
						[workspace, `${prefix}_overflow`],
					);
					expect(result.rowCount).toBe(50000);
				},
				async () => {
					if (createdIndex) await admin.query(`drop index "${cleanupIndex}"`);
				},
				async () => {
					expect(
						(
							await admin.query(
								"select count(*)::int n from pg_class where relname=$1",
								[cleanupIndex],
							)
						).rows[0].n,
					).toBe(0);
				},
			])),
		);
		finishCleanup(failures);
	};
}
function prepareOverflowEvidence(): Promise<void> {
	overflowSetupPromise = Promise.resolve().then(async () => {
		await admin.query(
			"insert into label(id,workspace_id,name,color) select $1||g,$2,'Bulk'||g,'gray' from generate_series(1,300) g",
			[`${prefix}_bulk`, workspace],
		);
		await admin.query(
			"insert into task_label(id,task_id,label_id) select $1||':'||id,$1,id from label where workspace_id=$2 and name like 'Bulk%'",
			[task, workspace],
		);
		overflowPositiveObservation = await observation();
		await admin.query(
			"insert into label(id,workspace_id,name,color) select $1||g,$2,'Overflow'||g,'gray' from generate_series(1,50000) g",
			[`${prefix}_overflow`, workspace],
		);
		await admin.query("analyze label");
		await admin.query(
			"insert into task_label(id,task_id,label_id) select $1||':'||id,$1,id from label where workspace_id=$2 and name like 'Overflow%'",
			[task, workspace],
		);
	});
	return overflowSetupPromise;
}

afterEach(async () => {
	await awaitDeferredCleanup();
});

beforeEach(async (context) => {
	await awaitDeferredCleanup();
	deferredCleanup = undefined;
	deferredCleanupPromise = undefined;
	overflowSetupPromise = undefined;
	overflowBehaviorPromise = undefined;
	overflowPositiveObservation = undefined;
	if (context.task.name === overflowCase) registerOverflowCleanup();
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
		"insert into label(id,workspace_id,name,color) values($1,$2,'Red','red'),($3,$2,'Blue','blue'),($4,$5,'Foreign','gray')",
		[red, workspace, blue, foreignLabel, hidden],
	);
	flushed.length = 0;
	const pat = await createPersonalAccessToken(runtime, alice, {
		name: "relationship writer",
		access: "write",
	});
	token = pat.token;
	tokenId = pat.id;
	bobToken = (
		await createPersonalAccessToken(runtime, bob, {
			name: "relationship writer",
			access: "write",
		})
	).token;
	if (context.task.name === overflowCase) await prepareOverflowEvidence();
});

afterAll(async () => {
	const failures = await collectCleanup([
		awaitDeferredCleanup,
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
const edit = (body: unknown, key: string = randomUUID(), secret = token) =>
	send(`tasks/${task}/relationships`, "PATCH", body, key, secret);
async function observation(secret = token) {
	const response = await send(
		`tasks/${task}/relationships`,
		"GET",
		undefined,
		randomUUID(),
		secret,
	);
	expect(response.status).toBe(200);
	return apiTaskRelationshipObservationSchema.parse(
		(await response.json()).data,
	);
}
async function body(secret = token) {
	return {
		workspaceId: workspace,
		listId: taskList,
		expectedState: (await observation(secret)).stateToken,
		assigneeIds: [bob],
		labelIds: [red],
	};
}
async function receiptCount() {
	return (
		await admin.query(
			"select count(*)::int n from public_api_request where user_id=any($1::text[])",
			[[alice, bob]],
		)
	).rows[0].n;
}
async function waitForLock(fragment?: string) {
	await vi.waitFor(
		async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and ($2::text is null or query like '%'||$2||'%')",
						[role, fragment ?? null],
					)
				).rows[0].n,
			).toBeGreaterThan(0);
		},
		{ timeout: 750, interval: 10 },
	);
}
async function nativeLabels(labelIds: string[], hold?: () => Promise<void>) {
	const client = await runtime.connect();
	const failures: unknown[] = [];
	try {
		await client.query("begin");
		await relationshipDatabase(client).transaction((tx) =>
			withZeroUserContext(tx, bob, () =>
				mutators.taskLabel.set.fn({
					tx,
					ctx: { id: bob },
					args: { taskId: task, labelIds },
				}),
			),
		);
		if (hold) await hold();
		await client.query("commit");
	} catch (error) {
		failures.push(error);
	} finally {
		failures.push(
			...(await releaseLockedClient(
				client,
				() => client.query("rollback"),
				[],
			)),
		);
		finishCleanup(failures);
	}
}

test("Member replacement commits assignments, labels, one receipt and native notice before flushing", async () => {
	const input = await body(bobToken);
	input.assigneeIds = [alice];
	const response = await edit(input, randomUUID(), bobToken);
	expect(response.status).toBe(200);
	const ack = apiTaskRelationshipsAckSchema.parse((await response.json()).data);
	expect(ack.snapshot).toMatchObject({
		taskId: task,
		listId: taskList,
		workspaceId: workspace,
		assigneeIds: [alice],
		labelIds: [red],
	});
	expect((await observation()).snapshot).toEqual(ack.snapshot);
	expect(await receiptCount()).toBe(1);
	expect(flushed.flat()).toMatchObject([
		{
			recipientUserId: alice,
			event: { kind: "assign", taskId: task, actorUserId: bob },
		},
	]);
});
test("clearing both sets reconciles recipients and an unchanged set creates no second notice", async () => {
	expect((await edit(await body())).status).toBe(200);
	expect(flushed.flat()).toHaveLength(1);
	expect((await edit(await body())).status).toBe(200);
	expect(flushed.flat()).toHaveLength(1);
	const clear = { ...(await body()), assigneeIds: [], labelIds: [] };
	expect((await edit(clear)).status).toBe(200);
	expect((await observation()).snapshot).toMatchObject({
		assigneeIds: [],
		labelIds: [],
	});
	expect(
		(
			await admin.query(
				"select count(*)::int n from task_notification_recipient where task_id=$1 and user_id=$2",
				[task, bob],
			)
		).rows[0].n,
	).toBe(0);
});
test.each([
	"assignment",
	"label",
])("stale %s sets refuse all effects while scalar changes do not alter relationship tokens", async (kind) => {
	const input = await body();
	const initial = input.expectedState;
	await admin.query("update task set title='Changed',priority=3 where id=$1", [
		task,
	]);
	expect((await observation()).stateToken).toBe(initial);
	if (kind === "assignment")
		await admin.query(
			"insert into task_assignee(id,task_id,user_id) values($1,$2,$3)",
			[`${task}:${alice}`, task, alice],
		);
	else await nativeLabels([blue]);
	expect((await edit(input)).status).toBe(409);
	expect(await receiptCount()).toBe(0);
	expect(flushed).toEqual([]);
});
test.each([
	"assignee",
	"label",
])("cross-workspace %s refuses atomically", async (kind) => {
	const input = await body();
	if (kind === "assignee") input.assigneeIds = [bob, outsider];
	else input.labelIds = [red, foreignLabel];
	expect((await edit(input)).status).toBe(400);
	expect(await receiptCount()).toBe(0);
	expect((await observation()).snapshot).toMatchObject({
		assigneeIds: [],
		labelIds: [],
	});
	expect(flushed).toEqual([]);
});
test("read tokens and Viewer members observe but cannot replace, removed members cannot observe", async () => {
	const read = (
		await createPersonalAccessToken(runtime, bob, {
			name: "Read",
			access: "read",
		})
	).token;
	expect((await observation(read)).snapshot.taskId).toBe(task);
	expect((await edit(await body(), randomUUID(), read)).status).toBe(403);
	await admin.query(
		"update membership set role='viewer' where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	expect((await observation(bobToken)).snapshot.taskId).toBe(task);
	expect((await edit(await body(), randomUUID(), bobToken)).status).toBe(403);
	await admin.query(
		"delete from membership where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	expect(
		(
			await send(
				`tasks/${task}/relationships`,
				"GET",
				undefined,
				randomUUID(),
				bobToken,
			)
		).status,
	).toBe(404);
});
test("pending activation rejects API assignments while native label replacement remains permitted", async () => {
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,'pending',1)",
		[task],
	);
	const input = await body();
	expect((await edit(input)).status).toBe(409);
	expect(await receiptCount()).toBe(0);
	await nativeLabels([blue]);
	expect((await observation()).snapshot.labelIds).toEqual([blue]);
});
test("concurrent identical key has one receipt and notice; reordered sets replay canonical input", async () => {
	const input = {
			...(await body()),
			assigneeIds: [alice, bob],
			labelIds: [red, blue],
		},
		key = randomUUID();
	const responses = await Promise.all([
		edit(input, key),
		edit({ ...input, assigneeIds: [bob, alice], labelIds: [blue, red] }, key),
	]);
	expect(responses.map((r) => r.status)).toEqual([200, 200]);
	expect(await receiptCount()).toBe(1);
	expect(flushed.flat()).toHaveLength(1);
	expect((await edit({ ...input, labelIds: [] }, key)).status).toBe(409);
});
test("historical receipt returns original desired sets without touching a recreated task or former assignee", async () => {
	const input = await body(),
		key = randomUUID();
	const first = await edit(input, key);
	expect(first.status).toBe(200);
	const ack = (await first.json()).data;
	await admin.query("delete from task where id=$1", [task]);
	await admin.query(
		"delete from membership where workspace_id=$1 and user_id=$2",
		[workspace, bob],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Other','a0')",
		[`${prefix}_replacement`, hidden, outsider],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Replacement','a0')",
		[task, `${prefix}_replacement`],
	);
	const replay = await edit(input, key);
	expect(replay.status).toBe(200);
	expect((await replay.json()).data).toEqual(ack);
	expect(flushed.flat()).toHaveLength(1);
	expect(
		(
			await admin.query(
				"select count(*)::int n from task_assignee where task_id=$1",
				[task],
			)
		).rows[0].n,
	).toBe(0);
	expect(
		(await admin.query("select title from task where id=$1", [task])).rows[0]
			.title,
	).toBe("Replacement");
	await admin.query(
		"update membership set role='viewer' where workspace_id=$1 and user_id=$2",
		[workspace, alice],
	);
	expect((await edit(input, key)).status).toBe(403);
	await admin.query(
		"delete from membership where workspace_id=$1 and user_id=$2",
		[workspace, alice],
	);
	expect((await edit(input, key)).status).toBe(404);
});
test.each([
	"hash",
	"taskId",
	"resource",
])("malformed %s receipt fails closed", async (change) => {
	const input = await body(),
		key = randomUUID();
	expect((await edit(input, key)).status).toBe(200);
	if (change === "hash")
		await admin.query(
			"update public_api_request set request_hash='bad' where user_id=$1 and request_id=$2",
			[alice, key],
		);
	else if (change === "taskId")
		await admin.query(
			"update public_api_request set task_id='different' where user_id=$1 and request_id=$2",
			[alice, key],
		);
	else
		await admin.query(
			"update public_api_request set resource_kind='list',task_id=null,list_id='other',list_snapshot='{\"id\":\"other\"}' where user_id=$1 and request_id=$2",
			[alice, key],
		);
	expect((await edit(input, key)).status).toBe(409);
	expect(flushed.flat()).toHaveLength(1);
});

test.each([
	"revoked_at=now()",
	"access='read'",
])("PAT %s after held canonical user lock is revalidated", async (change) => {
	const input = await body(),
		holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [alice]);
		pending = edit(input);
		await waitForLock('select id, deleted_at from "user"');
		await admin.query(
			`update personal_access_token set ${change} where id=$1`,
			[tokenId],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(
			change.startsWith("revoked") ? 401 : 403,
		);
		expect(await receiptCount()).toBe(0);
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
test("membership removal plus PAT revocation after held membership lock gives 401 precedence", async () => {
	const input = await body(),
		holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await holder.query("begin");
		await holder.query(
			"delete from membership where workspace_id=$1 and user_id=$2",
			[workspace, bob],
		);
		pending = edit(input, randomUUID(), bobToken);
		await waitForLock("select id from membership");
		await admin.query(
			"update personal_access_token set revoked_at=now() where user_id=$1",
			[bob],
		);
		await holder.query("commit");
		expect((await pending).status).toBe(401);
		expect(await receiptCount()).toBe(0);
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
test("native label writer holding canonical locks forces the API to observe its committed replacement", async () => {
	const input = await body();
	let ready!: () => void, release!: () => void;
	const locked = new Promise<void>((r) => (ready = r)),
		gate = new Promise<void>((r) => (release = r));
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	const native = nativeLabels([blue], async () => {
		ready();
		await gate;
	});
	try {
		await Promise.race([
			locked,
			native.then(() => {
				throw new Error("Native lock premise was not reached");
			}),
		]);
		pending = edit(input);
		await waitForLock();
		release();
		await native;
		expect((await pending).status).toBe(409);
		expect((await observation()).snapshot.labelIds).toEqual([blue]);
		expect(await receiptCount()).toBe(0);
	} catch (error) {
		failures.push(error);
	} finally {
		release();
		failures.push(
			...(await collectCleanup([async () => native, async () => pending])),
		);
		finishCleanup(failures);
	}
});
test("before-receipt SQL proves both native relationship effects then failure rolls back all effects and permits exact retry", async () => {
	const input = await body(),
		key = randomUUID(),
		fn = `${prefix}_fail_fn`,
		trigger = `${prefix}_fail_trigger`,
		sequence = `${prefix}_fail_seq`;
	const failures: unknown[] = [];
	let activeFn = false,
		activeTrigger = false,
		activeSeq = false;
	try {
		await admin.query(`create sequence "${sequence}"`);
		activeSeq = true;
		await admin.query(
			`grant usage, select on sequence "${sequence}" to "${role}"`,
		);
		await admin.query(
			`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then if not exists(select 1 from task_assignee where task_id=new.task_id and user_id=TG_ARGV[2]) or not exists(select 1 from task_label where task_id=new.task_id and label_id=TG_ARGV[3]) then raise exception 'fixture-effects-not-reached';end if;perform nextval(TG_ARGV[4]::regclass);raise exception 'fixture-after-native-before-receipt';end if;return new;end $fixture$`,
		);
		activeFn = true;
		const statement = await admin.query(
			"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text) statement",
			[trigger, fn, alice, key, bob, red, sequence],
		);
		await admin.query(statement.rows[0].statement);
		activeTrigger = true;
		expect((await edit(input, key)).status).toBe(500);
		expect(
			(await admin.query(`select last_value,is_called from "${sequence}"`))
				.rows[0],
		).toMatchObject({ last_value: "1", is_called: true });
		expect(await receiptCount()).toBe(0);
		expect((await observation()).snapshot).toMatchObject({
			assigneeIds: [],
			labelIds: [],
		});
		expect(flushed).toEqual([]);
		await admin.query(`drop trigger "${trigger}" on public_api_request`);
		activeTrigger = false;
		expect((await edit(input, key)).status).toBe(200);
		expect(await receiptCount()).toBe(1);
		expect(flushed.flat()).toHaveLength(1);
	} catch (error) {
		failures.push(error);
	} finally {
		failures.push(
			...(await collectCleanup([
				async () => {
					if (activeTrigger)
						await admin.query(
							`drop trigger "${trigger}" on public_api_request`,
						);
				},
				async () => {
					if (activeFn) await admin.query(`drop function "${fn}"()`);
				},
				async () => {
					if (activeSeq) await admin.query(`drop sequence "${sequence}"`);
				},
			])),
		);
		finishCleanup(failures);
	}
});
test(overflowCase, async () => {
	overflowBehaviorPromise = Promise.resolve().then(async () => {
		expect(overflowPositiveObservation?.snapshot.labelIds).toHaveLength(300);
		expect(
			(
				await admin.query(
					"select count(*)::int n from task_label where task_id=$1",
					[task],
				)
			).rows[0].n,
		).toBe(50300);
		expect(
			(
				await admin.query(
					"select count(*)::int n from pg_class where relname=$1",
					[`${prefix}_lc`],
				)
			).rows[0].n,
		).toBe(0);
		expect((await send(`tasks/${task}/relationships`, "GET")).status).toBe(503);
		expect(await receiptCount()).toBe(0);
		expect(flushed).toHaveLength(0);
		expect(
			(
				await admin.query(
					"select count(*)::int n from task_label where task_id=$1",
					[task],
				)
			).rows[0].n,
		).toBe(50300);
	});
	await overflowBehaviorPromise;
});
// Observe the real 5s deadline plus positive-read and client-release overhead.
test("actual SQL scan delay obeys deadline and connection-local timeout restoration on success", async () => {
	const client = await runtime.connect();
	const failures: unknown[] = [];
	try {
		await client.query("begin");
		await client.query(
			"select set_config('ditero.user_id',$1,true),set_config('statement_timeout','9000ms',true)",
			[alice],
		);
		expect((await visibleTaskRelationships(client, alice, task))?.taskId).toBe(
			task,
		);
		expect(
			(
				await client.query(
					"select current_setting('statement_timeout') timeout",
				)
			).rows[0].timeout,
		).toBe("9s");
		const delayed = new Proxy(client, {
			get(target, key, receiver) {
				if (key !== "query") return Reflect.get(target, key, receiver);
				return (sql: string, values?: unknown[]) =>
					target.query(
						sql.startsWith("declare api_task_relationships")
							? sql
									.replace(
										"with seat as",
										"with delay as materialized (select pg_sleep(5.1)), seat as",
									)
									.replace(
										"from task t join list",
										"from task t cross join delay join list",
									)
							: sql,
						values,
					);
			},
		});
		await expect(
			visibleTaskRelationships(delayed, alice, task),
		).rejects.toMatchObject({ code: "57014" });
	} catch (error) {
		failures.push(error);
	} finally {
		failures.push(
			...(await releaseLockedClient(
				client,
				() => client.query("rollback"),
				[],
			)),
		);
		finishCleanup(failures);
	}
}, 7000);
test.each([
	"tasks",
	"complete",
	"update",
	"delete",
	"lists",
])("caller UUID conflicts in both directions with %s", async (operation) => {
	const input = await body();
	async function other(key: string) {
		if (operation === "tasks")
			return send("tasks", "POST", { listId: taskList, title: "Created" }, key);
		if (operation === "lists")
			return send(
				"lists",
				"POST",
				{ workspaceId: workspace, title: "Created", kind: "tasks" },
				key,
			);
		if (operation === "complete")
			return send(
				`tasks/${task}/complete`,
				"POST",
				{ listId: taskList, expectedDueAt: null },
				key,
			);
		if (operation === "update") {
			const response = await send(`tasks/${task}/observation`, "GET");
			return send(
				`tasks/${task}`,
				"PATCH",
				{
					listId: taskList,
					expectedState: (await response.json()).data.stateToken,
					patch: { title: "Changed" },
				},
				key,
			);
		}
		const response = await send(`tasks/${task}/deletion-observation`, "GET"),
			observed = (await response.json()).data;
		return send(
			`tasks/${task}`,
			"DELETE",
			{
				listId: taskList,
				expectedState: observed.stateToken,
				expectedChildrenState: observed.childrenState,
				cascadeChildren: false,
			},
			key,
		);
	}
	const first = randomUUID();
	expect((await edit(input, first)).status).toBe(200);
	expect((await other(first)).status).toBe(409);
	const second = randomUUID();
	expect([200, 201]).toContain((await other(second)).status);
	expect((await edit(input, second)).status).toBe(409);
});
test("query, media, duplicate references, unsupported fields and UTF-8 bodies above 64 KiB fail before effects", async () => {
	const input = await body();
	expect(
		(await send(`tasks/${task}/relationships?x=1`, "PATCH", input)).status,
	).toBe(400);
	expect((await edit({ ...input, extra: true })).status).toBe(400);
	expect((await edit({ ...input, assigneeIds: [bob, bob] })).status).toBe(400);
	const request = new Request(
		`http://localhost/api/v1/tasks/${task}/relationships`,
		{
			method: "PATCH",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "text/plain",
				"idempotency-key": randomUUID(),
			},
			body: JSON.stringify(input),
		},
	);
	expect((await app.handle(request)).status).toBe(415);
	expect((await edit({ ...input, extra: "é".repeat(33000) })).status).toBe(413);
	expect(await receiptCount()).toBe(0);
});

test("API writer holding canonical locks orders a concurrent native label replacement after its receipt", async () => {
	const input = await body(),
		key = randomUUID(),
		fn = `${prefix}_pause_fn`,
		trigger = `${prefix}_pause_trigger`,
		barrierKey = `${prefix}_barrier`;
	const barrier = await admin.connect();
	let pending: Promise<Response> | undefined, native: Promise<void> | undefined;
	let activeFn = false,
		activeTrigger = false;
	const failures: unknown[] = [];
	try {
		await barrier.query("select pg_advisory_lock(hashtextextended($1,0))", [
			barrierKey,
		]);
		await admin.query(
			`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then if not exists(select 1 from task_label where task_id=new.task_id and label_id=TG_ARGV[2]) then raise exception 'fixture-native-label-not-reached';end if;perform pg_advisory_xact_lock(hashtextextended(TG_ARGV[3],0));end if;return new;end $fixture$`,
		);
		activeFn = true;
		const statement = await admin.query(
			"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text,$6::text) statement",
			[trigger, fn, alice, key, red, barrierKey],
		);
		await admin.query(statement.rows[0].statement);
		activeTrigger = true;
		pending = edit(input, key);
		await waitForLock("insert into public_api_request");
		native = nativeLabels([blue]);
		await waitForLock('select id, deleted_at from "user"');
		await barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
			barrierKey,
		]);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(
			apiTaskRelationshipsAckSchema.parse((await response.json()).data).snapshot
				.labelIds,
		).toEqual([red]);
		await native;
		expect((await observation()).snapshot.labelIds).toEqual([blue]);
		expect(await receiptCount()).toBe(1);
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
				[async () => pending, async () => native],
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
					if (activeFn) await admin.query(`drop function "${fn}"()`);
				},
			])),
		);
		finishCleanup(failures);
	}
});
test("membership downgrade committed while its lock is held is checked after locks", async () => {
	const input = await body(),
		holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await holder.query("begin");
		await holder.query(
			"update membership set role='viewer' where workspace_id=$1 and user_id=$2",
			[workspace, bob],
		);
		pending = edit(input, randomUUID(), bobToken);
		await waitForLock("select id from membership");
		await holder.query("commit");
		expect((await pending).status).toBe(403);
		expect(await receiptCount()).toBe(0);
		expect((await observation()).snapshot).toMatchObject({
			assigneeIds: [],
			labelIds: [],
		});
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
test("fresh identical semantic recreation may match, while a completed key never repeats assignment effects", async () => {
	const input = await body(),
		key = randomUUID();
	await admin.query("delete from task where id=$1", [task]);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Recreated','a0')",
		[task, taskList],
	);
	expect((await edit(input, key)).status).toBe(200);
	expect(flushed.flat()).toHaveLength(1);
	await nativeLabels([blue]);
	expect((await edit(input, key)).status).toBe(200);
	expect((await observation()).snapshot.labelIds).toEqual([blue]);
	expect(flushed.flat()).toHaveLength(1);
});

test("a same-key duplicate waiting behind uncommitted native effects replays the first receipt", async () => {
	const input = await body(),
		key = randomUUID(),
		fn = `${prefix}_pause_fn`,
		trigger = `${prefix}_pause_trigger`,
		barrierKey = `${prefix}_barrier`;
	const barrier = await admin.connect();
	let pending: Promise<Response> | undefined,
		duplicate: Promise<Response> | undefined;
	let activeFn = false,
		activeTrigger = false;
	const failures: unknown[] = [];
	try {
		await barrier.query("select pg_advisory_lock(hashtextextended($1,0))", [
			barrierKey,
		]);
		await admin.query(
			`create function "${fn}"() returns trigger language plpgsql as $fixture$ begin if new.user_id=TG_ARGV[0] and new.request_id::text=TG_ARGV[1] then if not exists(select 1 from task_assignee where task_id=new.task_id and user_id=TG_ARGV[2]) or not exists(select 1 from task_label where task_id=new.task_id and label_id=TG_ARGV[3]) then raise exception 'fixture-native-effects-not-reached';end if;perform pg_advisory_xact_lock(hashtextextended(TG_ARGV[4],0));end if;return new;end $fixture$`,
		);
		activeFn = true;
		const statement = await admin.query(
			"select format('create trigger %I before insert on public_api_request for each row execute function %I(%L,%L,%L,%L,%L)',$1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text) statement",
			[trigger, fn, alice, key, bob, red, barrierKey],
		);
		await admin.query(statement.rows[0].statement);
		activeTrigger = true;
		pending = edit(input, key);
		await waitForLock("insert into public_api_request");
		expect(await receiptCount()).toBe(0);
		expect(
			(
				await admin.query(
					"select (select count(*)::int from task where id=$1) as tasks, (select count(*)::int from task_assignee where task_id=$1) as assignees, (select count(*)::int from task_label where task_id=$1) as labels",
					[task],
				)
			).rows[0],
		).toEqual({ tasks: 1, assignees: 0, labels: 0 });
		duplicate = edit(input, key);
		await waitForLock('select id, deleted_at from "user"');
		await barrier.query("select pg_advisory_unlock(hashtextextended($1,0))", [
			barrierKey,
		]);
		const response = await pending,
			replay = await duplicate;
		expect([response.status, replay.status]).toEqual([200, 200]);
		const ack = apiTaskRelationshipsAckSchema.parse(
			(await response.json()).data,
		);
		expect((await replay.json()).data).toEqual(ack);
		expect((await observation()).snapshot).toEqual(ack.snapshot);
		expect(await receiptCount()).toBe(1);
		expect(flushed.flat()).toHaveLength(1);
		expect(flushed.flat()[0]).toMatchObject({
			recipientUserId: bob,
			event: { kind: "assign", taskId: task, actorUserId: alice },
		});
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
				[async () => pending, async () => duplicate],
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
					if (activeFn) await admin.query(`drop function "${fn}"()`);
				},
			])),
		);
		finishCleanup(failures);
	}
});
