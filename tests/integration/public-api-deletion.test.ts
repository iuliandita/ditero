import { createHash, randomUUID } from "node:crypto";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ApiTaskDelete } from "../../src/domain/public-api-task-deletion.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	listPersonalAccessTokens,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";
import { mutators } from "../../src/zero/mutators.ts";
import { schema } from "../../src/zero/schema.gen.ts";
import { withZeroUserContext } from "../../src/zero/task-activation.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const role = `api_delete_${randomUUID().replaceAll("-", "")}`;
const runtime = new Pool({
	connectionString: databaseURL,
	options: `-c role=${role}`,
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
const zdb = zeroNodePg(schema, runtime);
let token: string;
let initial: ApiTaskDelete;
beforeAll(async () => {
	await admin.query(
		`create role "${role}" nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows[0],
	).toEqual({ rolsuper: false, rolbypassrls: false });
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		`insert into "user"(id,name,email,email_verified) values('owner','Owner','owner@delete.test',true),('member','Member','member@delete.test',true),('viewer','Viewer','viewer@delete.test',true),('outsider','Outsider','outsider@delete.test',true)`,
	);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values('workspace','Shared','owner','shared')",
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values('owner-seat','owner','workspace','owner'),('member-seat','member','workspace','member'),('viewer-seat','viewer','workspace','viewer')",
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values('list','workspace','owner','Tasks','a0'),('moved','workspace','owner','Moved','a1')",
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key,created_at) values('task','list','Parent','a0','2026-10-03T10:00:00.123456Z'),('sibling','list','Sibling','a1',now())",
	);
	token = (
		await createPersonalAccessToken(runtime, "member", {
			name: "writer",
			access: "write",
		})
	).token;
	initial = await observed();
});
afterAll(async () => {
	await resetAuthFixture(admin);
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
function observation(secret = token, suffix = "") {
	return app.handle(
		new Request(
			`http://localhost/api/v1/tasks/task/deletion-observation${suffix}`,
			{ headers: { authorization: `Bearer ${secret}` } },
		),
	);
}
async function observed(secret = token): Promise<ApiTaskDelete> {
	const response = await observation(secret);
	expect(response.status).toBe(200);
	const { data } = await response.json();
	return {
		listId: data.snapshot.listId,
		expectedState: data.stateToken,
		expectedChildrenState: data.childrenState,
		cascadeChildren: false,
	};
}
function remove(
	body: unknown = initial,
	key: string | null = randomUUID(),
	secret = token,
	suffix = "",
) {
	const headers = new Headers({
		authorization: `Bearer ${secret}`,
		"content-type": "application/json",
	});
	if (key !== null) headers.set("idempotency-key", key);
	return app.handle(
		new Request(`http://localhost/api/v1/tasks/task${suffix}`, {
			method: "DELETE",
			headers,
			body: JSON.stringify(body),
		}),
	);
}
async function child() {
	await admin.query(
		"insert into task(id,list_id,title,sort_key,parent_id,created_at) values('child','list','Child','a2','task','2026-10-03T10:00:00.123456Z')",
	);
}
async function preserved(count = 2) {
	expect(
		(await admin.query("select count(*)::int n from task")).rows[0].n,
	).toBe(count);
	expect(
		(await admin.query("select count(*)::int n from public_api_request"))
			.rows[0].n,
	).toBe(0);
}
async function problem(response: Response, status: number, code: string) {
	expect(response.status).toBe(status);
	expect(await response.json()).toMatchObject({ code });
}
async function blocked() {
	await vi.waitFor(
		async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",
						[role],
					)
				).rows[0].n,
			).toBeGreaterThan(0);
		},
		{ timeout: 800, interval: 10 },
	);
}

test("read tokens and viewers observe exact children, but cannot delete; outsiders cannot observe", async () => {
	await child();
	const read = (
		await createPersonalAccessToken(runtime, "member", {
			name: "reader",
			access: "read",
		})
	).token;
	const viewer = (
		await createPersonalAccessToken(runtime, "viewer", {
			name: "viewer",
			access: "write",
		})
	).token;
	const outsider = (
		await createPersonalAccessToken(runtime, "outsider", {
			name: "outsider",
			access: "write",
		})
	).token;
	expect((await observed(read)).expectedChildrenState.count).toBe(1);
	expect((await observed(viewer)).expectedChildrenState.count).toBe(1);
	await problem(
		await remove(initial, randomUUID(), read),
		403,
		"insufficient-access",
	);
	await problem(await remove(initial, randomUUID(), viewer), 403, "forbidden");
	await problem(await observation(outsider), 404, "not-found");
	await preserved(3);
});
test("explicit empty scope deletes atomically and returns a retained result", async () => {
	const key = randomUUID();
	const first = await remove(initial, key);
	expect(first.status).toBe(200);
	const result = await first.json();
	expect(result.data).toEqual({
		taskId: "task",
		listId: "list",
		deleted: true,
		deletedChildren: 0,
	});
	expect(await (await remove(initial, key)).json()).toEqual(result);
	expect((await admin.query("select id from task")).rows).toEqual([
		{ id: "sibling" },
	]);
	expect(
		(await admin.query("select count(*)::int n from public_api_request"))
			.rows[0].n,
	).toBe(1);
});
test("false scope refuses observed children while true scope deletes that family only", async () => {
	await child();
	const input = await observed();
	await problem(await remove(input), 409, "task-state-changed");
	await preserved(3);
	const result = await remove({ ...input, cascadeChildren: true });
	expect(result.status).toBe(200);
	expect((await result.json()).data.deletedChildren).toBe(1);
	expect((await admin.query("select id from task")).rows).toEqual([
		{ id: "sibling" },
	]);
});
test.each([
	"added",
	"removed",
	"reparented",
])("%s child invalidates the observed family", async (kind) => {
	await child();
	const input = { ...(await observed()), cascadeChildren: true };
	if (kind === "added")
		await admin.query(
			"insert into task(id,list_id,title,sort_key,parent_id) values('new-child','list','New','a3','task')",
		);
	else if (kind === "removed")
		await admin.query("delete from task where id='child'");
	else
		await admin.query("update task set parent_id='sibling' where id='child'");
	await problem(await remove(input), 409, "task-state-changed");
	expect(
		(await admin.query("select id from task where id='task'")).rowCount,
	).toBe(1);
	expect(
		(await admin.query("select count(*)::int n from public_api_request"))
			.rows[0].n,
	).toBe(0);
});
const childChanges = [
	["id", "'other-child'"],
	["list_id", "'moved'"],
	["title", "'Edited'"],
	["notes", "'Changed'"],
	["done", "true"],
	["has_import_activation", "true"],
	["due_at", "'2026-10-04T10:00:00.123456Z'"],
	["due_all_day", "true"],
	["priority", "2"],
	["completed_at", "'2026-10-04T10:00:00.123456Z'"],
	["created_at", "'2026-10-03T10:00:00.123457Z'"],
	["sort_key", "'a3'"],
	["quantity", "'2'"],
	["unit", "'kg'"],
	["category", "'food'"],
	["rrule", "'FREQ=DAILY'"],
	["recurrence_relative", "true"],
	["reminder_time", "'10:00'"],
	["repeat_every_min", "5"],
	["max_repeats", "2"],
	["fallback_user_id", "'owner'"],
	["urgent", "true"],
] as const;
test.each(
	childChanges,
)("child persisted field %s invalidates the token", async (field, value) => {
	await child();
	const input = { ...(await observed()), cascadeChildren: true };
	await admin.query(`update task set ${field}=${value} where id='child'`);
	const response = await remove(input);
	// A changed list is outside the native one-list deletion invariant and fails closed.
	await problem(response, 409, "task-state-changed");
	expect(
		(await admin.query("select id from task where id='task'")).rowCount,
	).toBe(1);
	expect(
		(await admin.query("select count(*)::int n from public_api_request"))
			.rows[0].n,
	).toBe(0);
});
test("recurrence anchor and consumed state are both observed", async () => {
	await child();
	await admin.query(
		"update task set recurrence_anchor_at='2026-10-03T10:00:00.123456Z',recurrence_consumed=1 where id='child'",
	);
	let input = { ...(await observed()), cascadeChildren: true };
	await admin.query(
		"update task set recurrence_anchor_at='2026-10-03T10:00:00.123457Z' where id='child'",
	);
	await problem(await remove(input), 409, "task-state-changed");
	input = { ...(await observed()), cascadeChildren: true };
	await admin.query("update task set recurrence_consumed=2 where id='child'");
	await problem(await remove(input), 409, "task-state-changed");
	await preserved(3);
});
test.each([
	"edited",
	"moved",
])("%s parent scalar observation refuses", async (kind) => {
	await admin.query(
		kind === "edited"
			? "update task set title='Edited' where id='task'"
			: "update task set list_id='moved' where id='task'",
	);
	await problem(await remove(), 409, "task-state-changed");
	await preserved();
});
test("cursor pages include more than 256 children and do not cap native deletion", async () => {
	await admin.query(
		"insert into task(id,list_id,title,sort_key,parent_id) select 'child-'||lpad(n::text,4,'0'),'list','Child','a'||n,'task' from generate_series(1,300) n",
	);
	const input = { ...(await observed()), cascadeChildren: true };
	expect(input.expectedChildrenState.count).toBe(300);
	const result = await remove(input);
	expect(result.status).toBe(200);
	expect((await result.json()).data.deletedChildren).toBe(300);
	expect((await admin.query("select id from task")).rows).toEqual([
		{ id: "sibling" },
	]);
});
test("matching replay cannot delete a recreated ID and still requires origin write authority", async () => {
	const key = randomUUID();
	const result = await (await remove(initial, key)).json();
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values('task','moved','Recreated','a0')",
	);
	expect(await (await remove(initial, key)).json()).toEqual(result);
	expect(
		(await admin.query("select title from task where id='task'")).rows[0].title,
	).toBe("Recreated");
	await admin.query(
		"update membership set role='viewer' where id='member-seat'",
	);
	await problem(await remove(initial, key), 403, "forbidden");
	await admin.query("delete from membership where id='member-seat'");
	await problem(await remove(initial, key), 404, "not-found");
});
test("another body or operation using the shared UUID refuses without effects", async () => {
	const key = randomUUID();
	const response = await app.handle(
		new Request("http://localhost/api/v1/tasks/task", {
			method: "PATCH",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				"idempotency-key": key,
			},
			body: JSON.stringify({
				listId: "list",
				expectedState: initial.expectedState,
				patch: { title: "Updated" },
			}),
		}),
	);
	expect(response.status).toBe(200);
	await problem(await remove(initial, key), 409, "idempotency-conflict");
	const next = await observed();
	const deletionKey = randomUUID();
	expect((await remove(next, deletionKey)).status).toBe(200);
	await problem(
		await remove({ ...next, cascadeChildren: true }, deletionKey),
		409,
		"idempotency-conflict",
	);
});
test("concurrent same-key requests commit once and different keys do not silently replay", async () => {
	const key = randomUUID();
	expect(
		(await Promise.all([remove(initial, key), remove(initial, key)])).map(
			(r) => r.status,
		),
	).toEqual([200, 200]);
	expect(
		(await admin.query("select count(*)::int n from public_api_request"))
			.rows[0].n,
	).toBe(1);
	await problem(await remove(initial, randomUUID()), 404, "not-found");
});
async function attachment(id: string, kind = "task", parent = "task") {
	await admin.query(
		"insert into workspace_key(id,workspace_id,version,commitment,minted_by) values('key','workspace',1,'wdkc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA','owner') on conflict do nothing",
	);
	await admin.query(
		`insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,observed_bytes,ciphertext_sha256,storage_key,uploaded_by,committed_at) values($1,'workspace',$2,$3,1,'committed','name','type','dek',4,4,$4,$5,'owner',now())`,
		[id, kind, parent, "a".repeat(64), `workspace/${id}/content`],
	);
}
test("native cascade retires parent, child and comment attachments and removes completion/activation rows", async () => {
	await child();
	await admin.query(
		"insert into comment(id,task_id,author_id,body) values('comment','child','owner','Comment')",
	);
	await attachment("parent-file");
	await attachment("child-file", "task", "child");
	await attachment("comment-file", "comment", "comment");
	await attachment("sibling-file", "task", "sibling");
	await zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", () =>
			mutators.task.complete.fn({
				tx,
				ctx: { id: "owner" },
				args: { id: "child" },
			}),
		),
	);
	expect(
		(
			await admin.query(
				"select count(*)::int n from task_completion_event where task_id='child'",
			)
		).rows[0].n,
	).toBe(1);
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values('task','pending',1),('child','blocked',1)",
	);
	const input = { ...(await observed()), cascadeChildren: true };
	expect((await remove(input)).status).toBe(200);
	expect(
		(await admin.query("select id,state from attachment order by id")).rows,
	).toEqual([
		{ id: "child-file", state: "deleting" },
		{ id: "comment-file", state: "deleting" },
		{ id: "parent-file", state: "deleting" },
		{ id: "sibling-file", state: "committed" },
	]);
	for (const table of [
		"comment",
		"task_completion_event",
		"task_notification_activation",
	])
		expect(
			(await admin.query(`select count(*)::int n from ${table}`)).rows[0].n,
		).toBe(0);
});
test("receipt failure rolls back native deletion and attachment retirement", async () => {
	await child();
	await attachment("rollback-file");
	const input = { ...(await observed()), cascadeChildren: true };
	await admin.query(
		"create function deletion_reject_receipt() returns trigger language plpgsql as $$ begin raise exception 'fixture receipt failure'; end $$",
	);
	await admin.query(
		"create trigger deletion_reject before insert on public_api_request for each row execute function deletion_reject_receipt()",
	);
	try {
		expect((await remove(input)).status).toBe(500);
		await preserved(3);
		expect(
			(
				await admin.query(
					"select state,deleted_at from attachment where id='rollback-file'",
				)
			).rows[0],
		).toEqual({ state: "committed", deleted_at: null });
	} finally {
		await admin.query(
			"drop trigger deletion_reject on public_api_request;drop function deletion_reject_receipt()",
		);
	}
});
test("retained history ledger and redaction survive native family deletion", async () => {
	const namespace = randomUUID(),
		id = `api-delete-ledger-${randomUUID()}`;
	await admin.query(
		`insert into import_history_ledger(id,collection,target_parent_id,source_namespace,source_row_id,source_row_id_sha256,target_id,content_digest) values($1,'comments','task',$2,'source-row',$3,'deleted-comment',$4)`,
		[
			id,
			namespace,
			createHash("sha256").update("source-row").digest("hex"),
			"c".repeat(64),
		],
	);
	await admin.query(
		"insert into import_history_redaction(ledger_id) values($1)",
		[id],
	);
	try {
		expect((await remove()).status).toBe(200);
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
		await admin.query(
			"alter table import_history_redaction disable trigger user;alter table import_history_ledger disable trigger user",
		);
		try {
			await admin.query(
				"delete from import_history_redaction where ledger_id=$1",
				[id],
			);
			await admin.query("delete from import_history_ledger where id=$1", [id]);
		} finally {
			await admin.query(
				"alter table import_history_redaction enable trigger user;alter table import_history_ledger enable trigger user",
			);
		}
	}
});
test.each([
	"revoked",
	"expired",
	"deleted-actor",
])("%s during actual native authority-lock wait refuses before deletion", async (kind) => {
	const [metadata] = await listPersonalAccessTokens(runtime, "member");
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"member",
		]);
		pending = remove();
		await blocked();
		await holder.query(
			kind === "deleted-actor"
				? 'update "user" set deleted_at=now() where id=$1'
				: kind === "revoked"
					? "update personal_access_token set revoked_at=now() where id=$1"
					: "update personal_access_token set created_at=now()-interval '2 days',expires_at=now()-interval '1 second' where id=$1",
			[kind === "deleted-actor" ? "member" : metadata.id],
		);
		await holder.query("commit");
		await problem(await pending, 401, "unauthorized");
		await preserved();
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});
test("revocation refuses a matching completed receipt", async () => {
	const key = randomUUID();
	expect((await remove(initial, key)).status).toBe(200);
	const [metadata] = await listPersonalAccessTokens(runtime, "member");
	await revokePersonalAccessToken(runtime, "member", metadata.id);
	await problem(await remove(initial, key), 401, "unauthorized");
});
test.each([
	"add",
	"edit",
	"move",
])("actual Zero %s during lock wait cannot delete unobserved child state", async (kind) => {
	await child();
	const input = { ...(await observed()), cascadeChildren: true };
	const started = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const changing = zdb.transaction((tx) =>
		withZeroUserContext(tx, "owner", async () => {
			if (kind === "add")
				await mutators.task.create.fn({
					tx,
					ctx: { id: "owner" },
					args: {
						id: "new-child",
						listId: "list",
						title: "New child",
						sortKey: "a3",
						parentId: "task",
					},
				});
			else if (kind === "edit")
				await mutators.task.update.fn({
					tx,
					ctx: { id: "owner" },
					args: { id: "child", title: "Edited child" },
				});
			else
				await mutators.task.move.fn({
					tx,
					ctx: { id: "owner" },
					args: { id: "task", listId: "moved", sortKey: "a0" },
				});
			started.resolve();
			await release.promise;
		}),
	);
	let pending: Promise<Response> | undefined;
	try {
		await started.promise;
		pending = remove(input);
		await blocked();
		release.resolve();
		await changing;
		expect([409, 503]).toContain((await pending).status);
		await problem(await remove(input), 409, "task-state-changed");
		expect(
			(await admin.query("select id from task where id='task'")).rowCount,
		).toBe(1);
		expect(
			(await admin.query("select count(*)::int n from public_api_request"))
				.rows[0].n,
		).toBe(0);
	} finally {
		release.resolve();
		await Promise.allSettled([changing, pending]);
	}
});
test("wire bounds, malformed UTF8, explicit scope and missing key refuse", async () => {
	await problem(
		await remove({ ...initial, cascadeChildren: undefined }),
		400,
		"invalid-task",
	);
	await problem(await remove(initial, null), 400, "invalid-idempotency-key");
	await problem(
		await remove(initial, randomUUID(), token, "?unexpected=1"),
		400,
		"invalid-query",
	);
	for (const [body, status, code] of [
		[" ".repeat(4097) + JSON.stringify(initial), 413, "request-too-large"],
		[new Uint8Array([255]), 400, "invalid-json"],
	] as const) {
		const response = await app.handle(
			new Request("http://localhost/api/v1/tasks/task", {
				method: "DELETE",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					"idempotency-key": randomUUID(),
				},
				body,
			}),
		);
		await problem(response, status, code);
	}
	await preserved();
});

test("deleted actor during matching replay authority wait refuses after the native lock", async () => {
	const key = randomUUID();
	expect((await remove(initial, key)).status).toBe(200);
	const holder = await admin.connect();
	let pending: Promise<Response> | undefined;
	try {
		await holder.query("begin");
		await holder.query('select id from "user" where id=$1 for update', [
			"member",
		]);
		pending = remove(initial, key);
		await blocked();
		await holder.query('update "user" set deleted_at=now() where id=$1', [
			"member",
		]);
		await holder.query("commit");
		await problem(await pending, 401, "unauthorized");
		expect(
			(await admin.query("select count(*)::int n from public_api_request"))
				.rows[0].n,
		).toBe(1);
	} finally {
		await holder.query("rollback");
		holder.release();
		await pending;
	}
});
test("forged child count refuses even when the token matches", async () => {
	await child();
	const input = { ...(await observed()), cascadeChildren: true };
	input.expectedChildrenState = { ...input.expectedChildrenState, count: 0 };
	await problem(await remove(input), 409, "task-state-changed");
	await preserved(3);
});
