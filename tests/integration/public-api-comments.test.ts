import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
	apiCommentAckSchema,
	apiCommentObservationSchema,
} from "../../src/domain/public-api-comments.ts";
import type { CollectedEvent } from "../../src/server/notifications/events.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `comment_api_${randomUUID().replaceAll("-", "")}`;
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
const owner = `${prefix}_owner`,
	author = `${prefix}_author`,
	member = `${prefix}_member`,
	viewer = `${prefix}_viewer`,
	manager = `${prefix}_admin`,
	outsider = `${prefix}_outsider`;
const users = [owner, author, member, viewer, manager, outsider];
const workspace = `${prefix}_workspace`,
	hidden = `${prefix}_hidden`,
	list = `${prefix}_list`,
	foreignList = `${prefix}_foreign`,
	task = `${prefix}_task`,
	foreignTask = `${prefix}_foreign_task`,
	comment = `${prefix}_comment`;
const tokens = new Map<string, string>();
let readToken: string,
	roleCreated = false;
const flushed: CollectedEvent[] = [];
const app = publicApiRoutes(
	runtime,
	async () => true,
	async (events) => {
		for (const item of events) {
			expect(item.event.kind).toBe("mention");
			if (item.event.kind === "mention")
				expect(
					(
						await admin.query(
							"select comment_id from public_api_request where comment_id=$1",
							[item.event.commentId],
						)
					).rowCount,
				).toBe(1);
		}
		flushed.push(...events);
	},
);
async function cleanupData() {
	const failures: unknown[] = [];
	for (const [sql, args] of [
		[
			"delete from attachment where workspace_id=any($1::text[])",
			[[workspace, hidden]],
		],
		["delete from task where list_id=any($1::text[])", [[list, foreignList]]],
		[
			"delete from list where workspace_id=any($1::text[])",
			[[workspace, hidden]],
		],
		[
			"delete from membership where id=any($1::text[]) and user_id=any($2::text[]) and workspace_id=any($3::text[])",
			[users.map((id) => `${id}_seat`), users, [workspace, hidden]],
		],
		["delete from workspace where id=any($1::text[])", [[workspace, hidden]]],
		['delete from "user" where id=any($1::text[])', [users]],
	] as const)
		try {
			await admin.query(sql, [...args]);
		} catch (error) {
			failures.push(error);
		}
	if (failures.length)
		throw new AggregateError(failures, "owned comment fixture cleanup failed");
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
		`grant update(id) on "user",workspace,membership,list,task to "${role}"`,
	);
	await admin.query(
		`grant insert,update,delete on comment,personal_access_token,public_api_request to "${role}"`,
	);
	await admin.query(
		`grant update(state,deleted_at) on attachment to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select current_user,session_user,rolsuper,rolbypassrls,rolcanlogin,rolinherit,(select count(*)::int from pg_auth_members where member=r.oid) as memberships,(select count(*)::int from pg_class where relowner=r.oid) as owned_relations from pg_roles r where rolname=current_user",
			)
		).rows[0],
	).toEqual({
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
	// Comment visibility is explicitly enforced by the route/native membership gate.
	expect(
		(
			await runtime.query(
				"select relrowsecurity from pg_class where oid='comment'::regclass",
			)
		).rows[0].relrowsecurity,
	).toBe(false);
});
beforeEach(async () => {
	await cleanupData();
	flushed.length = 0;
	tokens.clear();
	for (const [id, name] of [
		[owner, "Owner"],
		[author, "Alice Author"],
		[member, "Alice Jones"],
		[viewer, "Alice Brown"],
		[manager, "Admin"],
		[outsider, "Alice Outside"],
	])
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
			[id, name, `${id}@example.test`],
		);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Comments',$2,'shared'),($3,'Hidden',$4,'shared')",
		[workspace, owner, hidden, outsider],
	);
	for (const [id, ws, seat] of [
		[owner, workspace, "owner"],
		[author, workspace, "member"],
		[member, workspace, "member"],
		[viewer, workspace, "viewer"],
		[manager, workspace, "admin"],
		[outsider, hidden, "owner"],
	])
		await admin.query(
			"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,$4)",
			[`${id}_seat`, id, ws, seat],
		);
	for (const [id, ws, own] of [
		[list, workspace, owner],
		[foreignList, hidden, outsider],
	])
		await admin.query(
			"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,'Comments','tasks','a0')",
			[id, ws, own],
		);
	for (const [id, l] of [
		[task, list],
		[foreignTask, foreignList],
	])
		await admin.query(
			"insert into task(id,list_id,title,sort_key,created_at) values($1,$2,'Original','a0',now())",
			[id, l],
		);
	await admin.query(
		"insert into comment(id,task_id,author_id,body,created_at) values($1,$2,$3,'Original','2026-10-04T00:00:00.123456Z')",
		[comment, task, author],
	);
	for (const userId of users)
		tokens.set(
			userId,
			(
				await createPersonalAccessToken(runtime, userId, {
					name: "comment writer",
					access: "write",
				})
			).token,
		);
	readToken = (
		await createPersonalAccessToken(runtime, author, {
			name: "comment reader",
			access: "read",
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
					[users],
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
		throw new AggregateError(errors, "comment fixture cleanup failed");
});
function send(
	path: string,
	method = "GET",
	input?: unknown,
	key = randomUUID(),
	secret = tokens.get(author),
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
const collection = `tasks/${task}/comments`;
const target = `${collection}/${comment}`;
async function observation(id = comment, secret = tokens.get(author)) {
	const result = await send(
		`${collection}/${id}/observation`,
		"GET",
		undefined,
		randomUUID(),
		secret,
	);
	expect(result.status).toBe(200);
	return apiCommentObservationSchema.parse((await result.json()).data);
}
async function createBody(body = "hello") {
	const response = await send(`tasks/${task}/observation`);
	expect(response.status).toBe(200);
	return {
		workspaceId: workspace,
		listId: list,
		expectedTaskState: (await response.json()).data.stateToken,
		body,
	};
}
async function updateBody(body = "edit", id = comment) {
	return {
		workspaceId: workspace,
		listId: list,
		expectedState: (await observation(id)).stateToken,
		body,
	};
}
async function deleteBody(id = comment) {
	return {
		workspaceId: workspace,
		listId: list,
		expectedState: (await observation(id)).stateToken,
		deleteScope: "comment-and-attachments",
	};
}
async function acknowledgment(response: Response) {
	expect(response.status).toBe(200);
	return apiCommentAckSchema.parse((await response.json()).data);
}
async function seedImported(id: string, body = "Imported") {
	await admin.query(
		"insert into comment(id,task_id,body,created_at,source_namespace,source_row_id,historical_author_kind,historical_author_namespace,historical_author_principal_id,historical_author_name,imported_at) values($1,$2,$3,'2026-10-04T00:00:00.123456Z',$4,'row-private','source_claim',$5,'principal-private','Original Person',now())",
		[id, task, body, randomUUID(), randomUUID()],
	);
}

test("restricted-role collection and compact observation hide provenance, bind pages and refuse complete oversized output", async () => {
	const imported = `${prefix}_imported`;
	await seedImported(imported, "é😀".repeat(50000));
	const observed = await observation(imported, tokens.get(viewer));
	expect(observed.snapshot.body).toEqual({
		sha256: createHash("sha256").update("é😀".repeat(50000)).digest("hex"),
		utf8Bytes: 300000,
	});
	expect(observed.snapshot.createdAt).toBe("2026-10-04T00:00:00.123456Z");
	expect(JSON.stringify(observed)).not.toMatch(
		/row-private|principal-private|sourceNamespace|historicalAuthorNamespace/,
	);
	expect(
		(await send(collection, "GET", undefined, randomUUID(), tokens.get(viewer)))
			.status,
	).toBe(413);
	expect(
		(
			await send(
				collection,
				"GET",
				undefined,
				randomUUID(),
				tokens.get(outsider),
			)
		).status,
	).toBe(404);
	const removed = await admin.query(
		"delete from comment where id=$1 and task_id=$2 returning id",
		[imported, task],
	);
	expect(removed.rowCount).toBe(1);
	await seedImported(imported, "Small");
	const first = await send(
		`${collection}?limit=1`,
		"GET",
		undefined,
		randomUUID(),
		tokens.get(viewer),
	);
	expect(first.status).toBe(200);
	const page = await first.json();
	expect(page.data).toHaveLength(1);
	expect(page.nextCursor).toBeTypeOf("string");
	const second = await send(`${collection}?limit=1&cursor=${page.nextCursor}`);
	expect(second.status).toBe(200);
	expect((await second.json()).data[0].commentId).not.toBe(
		page.data[0].commentId,
	);
	expect(
		(await send(`tasks/${foreignTask}/comments?cursor=${page.nextCursor}`))
			.status,
	).toBe(400);
	for (const suffix of ["?limit=1&limit=2", "?extra=1", "?limit=101"])
		expect((await send(collection + suffix)).status).toBe(400);
});

test("native creation mentions current name collisions after atomic commit; replay survives resource recreation without events", async () => {
	await admin.query(
		"insert into task_notification_activation(task_id,status,generation) values($1,'pending',1)",
		[task],
	);
	const input = await createBody("  @Alice @alice @AliceOutside  ");
	const key = randomUUID();
	const results = await Promise.all([
		send(collection, "POST", input, key),
		send(collection, "POST", input, key),
	]);
	const ack = await acknowledgment(results[0]);
	expect(await acknowledgment(results[1])).toEqual(ack);
	expect(ack.snapshot.body).toBe(input.body);
	expect(ack.kind).toBe("comment-create-ack");
	expect(flushed.map((item) => item.recipientUserId).sort()).toEqual(
		[member, viewer].sort(),
	);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from comment where task_id=$1",
				[task],
			)
		).rows[0].count,
	).toBe(2);
	const events = flushed.length;
	await admin.query("delete from task where id=$1", [task]);
	await admin.query("delete from list where id=$1", [list]);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,'Replacement','tasks','a0')",
		[list, hidden, outsider],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Replacement','a0')",
		[task, list],
	);
	await admin.query(
		"insert into comment(id,task_id,author_id,body) values($1,$2,$3,'Replacement')",
		[ack.snapshot.commentId, task, outsider],
	);
	expect(
		await acknowledgment(await send(collection, "POST", input, key)),
	).toEqual(ack);
	expect(flushed).toHaveLength(events);
	expect(
		(
			await admin.query("select body from comment where id=$1", [
				ack.snapshot.commentId,
			])
		).rows[0].body,
	).toBe("Replacement");
	await admin.query(
		"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
		[author, workspace],
	);
	expect((await send(collection, "POST", input, key)).status).toBe(403);
	await admin.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[author, workspace],
	);
	expect((await send(collection, "POST", input, key)).status).toBe(404);
});

test("native author-only edits preserve exact large bodies, immutable replay and creation-only events", async () => {
	const input = await updateBody(`${" ".repeat(10001)}@Alice`);
	const key = randomUUID();
	for (const id of [owner, manager, member, viewer])
		expect(
			(await send(target, "PATCH", input, randomUUID(), tokens.get(id))).status,
		).toBe(403);
	expect(
		(await send(target, "PATCH", input, randomUUID(), readToken)).status,
	).toBe(403);
	const ack = await acknowledgment(await send(target, "PATCH", input, key));
	expect(ack.snapshot.body).toBe(input.body);
	expect(ack.snapshot.editedAt).not.toBeNull();
	expect(flushed).toHaveLength(0);
	await admin.query("update comment set body='Later edit' where id=$1", [
		comment,
	]);
	expect(await acknowledgment(await send(target, "PATCH", input, key))).toEqual(
		ack,
	);
	expect(
		(await admin.query("select body from comment where id=$1", [comment]))
			.rows[0].body,
	).toBe("Later edit");
	await admin.query("delete from comment where id=$1", [comment]);
	await admin.query(
		"insert into comment(id,task_id,author_id,body) values($1,$2,$3,'Recreated')",
		[comment, task, member],
	);
	expect(await acknowledgment(await send(target, "PATCH", input, key))).toEqual(
		ack,
	);
	expect(
		(await admin.query("select body from comment where id=$1", [comment]))
			.rows[0].body,
	).toBe("Recreated");
	const imported = `${prefix}_imported`;
	await seedImported(imported);
	const importedInput = await updateBody("new", imported);
	for (const id of [author, owner, manager])
		expect(
			(
				await send(
					`${collection}/${imported}`,
					"PATCH",
					importedInput,
					randomUUID(),
					tokens.get(id),
				)
			).status,
		).toBe(403);
});

test("explicit native deletion retires committed attachments, retains pending bytes and never deletes a recreated comment", async () => {
	for (const [id, state] of [
		[`${prefix}_committed`, "committed"],
		[`${prefix}_pending`, "reserved"],
	])
		await admin.query(
			"insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,observed_bytes,ciphertext_sha256,storage_key,uploaded_by,committed_at) values($1,$2,'comment',$3,1,$4,'name','type','dek',4,4,$5,$6,$7,now())",
			[
				id,
				workspace,
				comment,
				state,
				"a".repeat(64),
				`${workspace}/${id}/content`,
				author,
			],
		);
	const input = await deleteBody();
	const key = randomUUID();
	for (const id of [member, viewer])
		expect(
			(await send(target, "DELETE", input, randomUUID(), tokens.get(id)))
				.status,
		).toBe(403);
	expect(
		(await send(target, "DELETE", { ...input, deleteScope: "comment" })).status,
	).toBe(400);
	const ack = await acknowledgment(await send(target, "DELETE", input, key));
	expect(ack.kind).toBe("comment-delete-ack");
	expect(
		(
			await admin.query(
				"select id,state,deleted_at is not null as deleted from attachment where workspace_id=$1 order by id",
				[workspace],
			)
		).rows,
	).toEqual([
		{ id: `${prefix}_committed`, state: "deleting", deleted: true },
		{ id: `${prefix}_pending`, state: "reserved", deleted: false },
	]);
	expect(
		(await admin.query("select id from comment where id=$1", [comment]))
			.rowCount,
	).toBe(0);
	await admin.query(
		"insert into comment(id,task_id,author_id,body) values($1,$2,$3,'Replacement')",
		[comment, task, member],
	);
	expect(
		await acknowledgment(await send(target, "DELETE", input, key)),
	).toEqual(ack);
	expect(
		(await admin.query("select body from comment where id=$1", [comment]))
			.rows[0].body,
	).toBe("Replacement");
	expect(flushed).toHaveLength(0);
});

test("imported oversized comments stay observable and deletable only by admin authority", async () => {
	const imported = `${prefix}_imported`;
	const body = "x".repeat(300000);
	await seedImported(imported, body);
	const input = await deleteBody(imported);
	const key = randomUUID();
	expect(
		(await send(`${collection}/${imported}`, "DELETE", input, key)).status,
	).toBe(403);
	const ack = await acknowledgment(
		await send(
			`${collection}/${imported}`,
			"DELETE",
			input,
			key,
			tokens.get(manager),
		),
	);
	expect(ack.snapshot.body).toEqual({
		sha256: createHash("sha256").update(body).digest("hex"),
		utf8Bytes: 300000,
	});
	await admin.query(
		"update membership set role='member' where user_id=$1 and workspace_id=$2",
		[manager, workspace],
	);
	expect(
		(
			await send(
				`${collection}/${imported}`,
				"DELETE",
				input,
				key,
				tokens.get(manager),
			)
		).status,
	).toBe(403);
	expect(
		(await send(`${collection}/${imported}`, "DELETE", input, key, readToken))
			.status,
	).toBe(403);
});

test("observation binds timestamp microseconds, hidden provenance, body and scope before effects", async () => {
	const input = await updateBody();
	const original = await observation();
	await admin.query(
		"update comment set created_at=created_at+interval '1 microsecond' where id=$1",
		[comment],
	);
	const next = await observation();
	expect(next.snapshot.createdAt).not.toBe(original.snapshot.createdAt);
	expect(next.stateToken).not.toBe(original.stateToken);
	expect((await send(target, "PATCH", input)).status).toBe(409);
	expect(
		(await admin.query("select body from comment where id=$1", [comment]))
			.rows[0].body,
	).toBe("Original");
	const imported = `${prefix}_imported`;
	await seedImported(imported);
	const deletion = await deleteBody(imported);
	const previous = await observation(imported);
	const replaced = await admin.query(
		"with original as (delete from comment where id=$1 and task_id=$2 returning *) insert into comment(id,task_id,author_id,body,created_at,edited_at,source_namespace,source_row_id,historical_author_kind,historical_author_namespace,historical_author_principal_id,historical_author_name,imported_at,provenance_redacted_at) select id,task_id,author_id,body,created_at,edited_at,source_namespace,'changed-private',historical_author_kind,historical_author_namespace,historical_author_principal_id,historical_author_name,imported_at,provenance_redacted_at from original returning id",
		[imported, task],
	);
	expect(replaced.rowCount).toBe(1);
	const after = await observation(imported);
	expect(after.snapshot).toEqual(previous.snapshot);
	expect(after.stateToken).not.toBe(previous.stateToken);
	expect(
		(
			await send(
				`${collection}/${imported}`,
				"DELETE",
				deletion,
				randomUUID(),
				tokens.get(owner),
			)
		).status,
	).toBe(409);
	const create = await createBody("@Alice");
	await admin.query("update task set title='Changed' where id=$1", [task]);
	expect((await send(collection, "POST", create)).status).toBe(409);
	expect(flushed).toHaveLength(0);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from public_api_request where user_id=any($1::text[])",
				[users],
			)
		).rows[0].count,
	).toBe(0);
});

test("account-global UUID conflicts and receipt RLS/checks fail closed under the actual login role", async () => {
	const input = await createBody();
	const key = randomUUID();
	const ack = await acknowledgment(await send(collection, "POST", input, key));
	expect(
		(await send(collection, "POST", { ...input, body: "different" }, key))
			.status,
	).toBe(409);
	expect(
		(
			await send(
				`${collection}/${ack.snapshot.commentId}`,
				"PATCH",
				await updateBody("different", ack.snapshot.commentId),
				key,
			)
		).status,
	).toBe(409);
	expect(
		(
			await send(
				`tasks/${task}/relationships`,
				"PATCH",
				{
					workspaceId: workspace,
					listId: list,
					expectedState: "a".repeat(64),
					assigneeIds: [],
					labelIds: [],
				},
				key,
			)
		).status,
	).toBe(409);
	const client = await runtime.connect();
	try {
		expect(
			(
				await client.query(
					"select request_id from public_api_request where request_id=$1",
					[key],
				)
			).rowCount,
		).toBe(0);
		await client.query("begin");
		await client.query("select set_config('ditero.user_id',$1,true)", [member]);
		expect(
			(
				await client.query(
					"select request_id from public_api_request where request_id=$1",
					[key],
				)
			).rowCount,
		).toBe(0);
		await client.query("rollback");
		await client.query("begin");
		await client.query("select set_config('ditero.user_id',$1,true)", [author]);
		expect(
			(
				await client.query(
					"select request_id from public_api_request where request_id=$1",
					[key],
				)
			).rowCount,
		).toBe(1);
		await client.query("rollback");
		for (const malformed of [
			{ ...ack, originalWorkspaceId: hidden },
			{ ...ack, snapshot: { ...ack.snapshot, version: 2 } },
			{ ...ack, snapshot: { ...ack.snapshot, commentId: "other" } },
			{ ...ack, kind: "wrong" },
			{ ...ack, snapshot: { ...ack.snapshot, body: "x".repeat(300000) } },
		]) {
			await client.query("begin");
			await client.query("select set_config('ditero.user_id',$1,true)", [
				author,
			]);
			await expect(
				client.query(
					"insert into public_api_request(user_id,request_id,request_hash,resource_kind,comment_id,comment_snapshot) values($1,$2,'hash','comment',$3,$4::jsonb)",
					[
						author,
						randomUUID(),
						ack.snapshot.commentId,
						JSON.stringify(malformed),
					],
				),
			).rejects.toMatchObject({ code: "23514" });
			await client.query("rollback");
		}
		await client.query("begin");
		await client.query("select set_config('ditero.user_id',$1,true)", [member]);
		await expect(
			client.query(
				"insert into public_api_request(user_id,request_id,request_hash,resource_kind,comment_id,comment_snapshot) values($1,$2,'hash','comment',$3,$4::jsonb)",
				[author, randomUUID(), ack.snapshot.commentId, JSON.stringify(ack)],
			),
		).rejects.toMatchObject({ code: "42501" });
		await client.query("rollback");
	} finally {
		client.release();
	}
});

test("route transport validation refuses invalid UTF8, excessive bytes and hidden fields before mutation", async () => {
	const input = await createBody();
	for (const value of [
		{ ...input, body: "x".repeat(10001) },
		{ ...input, authorId: member },
		{ ...input, body: "\ud800" },
		{ ...input, body: "\0" },
	])
		expect((await send(collection, "POST", value)).status).toBe(400);
	const raw = (body: Uint8Array<ArrayBuffer>) =>
		app.handle(
			new Request(`http://localhost/api/v1/${collection}`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${tokens.get(author)}`,
					"content-type": "application/json",
					"idempotency-key": randomUUID(),
				},
				body,
			}),
		);
	expect((await raw(new Uint8Array([0xff]))).status).toBe(400);
	expect(
		(
			await raw(
				new TextEncoder().encode(
					JSON.stringify({ ...input, body: "x".repeat(65536) }),
				),
			)
		).status,
	).toBe(413);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from public_api_request where user_id=any($1::text[])",
				[users],
			)
		).rows[0].count,
	).toBe(0);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from comment where task_id=$1",
				[task],
			)
		).rows[0].count,
	).toBe(1);
	expect(flushed).toHaveLength(0);
	const empty = await acknowledgment(
		await send(collection, "POST", { ...input, body: "" }),
	);
	expect(empty.snapshot.body).toBe("");
});

test("rename after candidate recheck refuses the native unlocked mention and rolls back before receipt or flush", async () => {
	const input = await createBody("@Alice");
	const key = randomUUID();
	const barrier = await admin.connect();
	let pending: Promise<Response> | undefined;
	const failures: unknown[] = [];
	try {
		await barrier.query("begin");
		await barrier.query("lock table comment in share row exclusive mode");
		pending = send(collection, "POST", input, key);
		await vi.waitFor(
			async () => {
				expect(
					(
						await admin.query(
							"select count(*)::int as count from pg_stat_activity where application_name=$1 and wait_event_type='Lock' and lower(query) like '%insert%comment%'",
							[role],
						)
					).rows[0].count,
				).toBe(1);
			},
			{ timeout: 750, interval: 10 },
		);
		// This user did not match the pre-lock name scan and is not a list owner/actor.
		await admin.query('update "user" set name=$1 where id=$2', [
			"Alice Renamed",
			manager,
		]);
		expect(
			(await admin.query('select name from "user" where id=$1', [manager]))
				.rows[0].name,
		).toBe("Alice Renamed");
		await barrier.query("commit");
		const response = await pending;
		expect(response.status).toBe(503);
		expect((await response.json()).code).toBe("temporarily-unavailable");
		expect(
			(
				await admin.query(
					"select count(*)::int as count from comment where task_id=$1",
					[task],
				)
			).rows[0].count,
		).toBe(1);
		expect(
			(
				await admin.query(
					"select request_id from public_api_request where user_id=$1 and request_id=$2",
					[author, key],
				)
			).rowCount,
		).toBe(0);
		expect(
			(
				await admin.query(
					"select count(*)::int as count from notification_outbox where recipient_user_id=any($1::text[])",
					[users],
				)
			).rows[0].count,
		).toBe(0);
		expect(flushed).toHaveLength(0);
	} catch (error) {
		failures.push(error);
	} finally {
		let releaseFailed = false;
		try {
			await barrier.query("rollback");
		} catch (error) {
			failures.push(error);
			releaseFailed = true;
		}
		barrier.release(releaseFailed);
		try {
			if (pending) await pending;
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length)
		throw new AggregateError(failures, "rename-after-recheck fixture failed");
});
