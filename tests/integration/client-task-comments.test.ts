import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import journal from "../../drizzle/meta/_journal.json";
import {
	apiCommentAckSchema,
	apiCommentObservationSchema,
} from "../../src/domain/public-api-comments.ts";
import type { CollectedEvent } from "../../src/server/notifications/events.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_CLIENT_TASK_COMMENTS_TEST_DATABASE ?? "ditero_e2e";
if (
	process.env.NODE_ENV !== "test" ||
	!databaseURL ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error("Explicit test database and NODE_ENV=test are required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `client_comments_${randomUUID().replaceAll("-", "")}`,
	role = `${prefix}_runtime`,
	password = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
});
const alice = `${prefix}_alice`,
	bob = `${prefix}_bob`,
	outsider = `${prefix}_outsider`,
	workspace = `${prefix}_workspace`,
	hidden = `${prefix}_hidden`,
	existingList = `${prefix}_existing`,
	hiddenList = `${prefix}_hidden_list`,
	label = `${prefix}_label`,
	hiddenLabel = `${prefix}_hidden_label`;
const notices: CollectedEvent[] = [];
const app = publicApiRoutes(
	runtime,
	async () => true,
	async (events) => {
		expect(await receiptCount()).toBeGreaterThan(0);
		for (const entry of events) {
			if (entry.event.kind !== "mention")
				throw new Error("Unexpected comment event");
			expect(
				(
					await admin.query(
						"select comment_id from public_api_request where comment_id=$1",
						[entry.event.commentId],
					)
				).rowCount,
			).toBe(1);
			notices.push(entry);
		}
	},
);
let token = "",
	bobToken = "",
	readToken = "",
	origin = "",
	roleCreated = false,
	listening = false;
let dropKey: string | undefined;
const requests: {
	method: string;
	path: string;
	key: string | null;
	body: string;
}[] = [];
const dropped: { key: string; status: number }[] = [];
const failures: unknown[] = [];
const clients: Client[] = [];
const children = new Set<ChildProcess>();
async function reap(child: ChildProcess) {
	if (child.exitCode !== null || child.signalCode !== null) {
		children.delete(child);
		return;
	}
	const closed = new Promise<void>((resolve) =>
		child.once("close", () => resolve()),
	);
	child.kill("SIGTERM");
	const force = setTimeout(() => child.kill("SIGKILL"), 1000);
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			closed,
			new Promise<never>(
				(_resolve, reject) =>
					(deadline = setTimeout(
						() => reject(new Error("Owned CLI did not close after SIGKILL")),
						3000,
					)),
			),
		]);
	} finally {
		clearTimeout(force);
		clearTimeout(deadline);
		if (child.exitCode !== null || child.signalCode !== null)
			children.delete(child);
	}
}
const causes: unknown[] = [];
async function preserveCause(body: () => Promise<void>) {
	try {
		await body();
	} catch (error) {
		causes.push(error);
		throw error;
	}
}
const api = createServer(async (incoming, outgoing) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString("utf8");
		const path = incoming.url ?? "/";
		const method = incoming.method ?? "GET";
		const key =
			typeof incoming.headers["idempotency-key"] === "string"
				? incoming.headers["idempotency-key"]
				: null;
		requests.push({ method, path, key, body });
		const response = await app.handle(
			new Request(new URL(path, origin), {
				method,
				headers: incoming.headers as Record<string, string>,
				...(method === "GET" ? {} : { body }),
			}),
		);
		const bytes = await response.arrayBuffer();
		if (key && key === dropKey) {
			dropKey = undefined;
			dropped.push({ key, status: response.status });
			outgoing.destroy();
			return;
		}
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(Buffer.from(bytes));
	} catch (error) {
		failures.push(error);
		outgoing.destroy();
	}
});
beforeAll(async () =>
	preserveCause(async () => {
		expect(
			(await admin.query("select current_database() as database")).rows[0]
				.database,
		).toBe(expectedDatabase);
		expect(
			(
				await admin.query(
					"select count(*)::int as count from drizzle.__drizzle_migrations",
				)
			).rows[0].count,
		).toBe(journal.entries.length);
		const statement = await admin.query<{ statement: string }>(
			"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) as statement",
			[role, password],
		);
		await admin.query(statement.rows[0].statement);
		roleCreated = true;
		await admin.query(`grant usage on schema public to "${role}"`);
		await admin.query(
			`grant select,insert,update,delete on all tables in schema public to "${role}"`,
		);
		expect(
			(
				await runtime.query(
					"select current_user,session_user,rolsuper,rolbypassrls,rolinherit,rolcanlogin,(select count(*)::int from pg_auth_members where member=r.oid or roleid=r.oid) as memberships,(select count(*)::int from pg_class where relowner=r.oid) as owned from pg_roles r where rolname=current_user",
				)
			).rows[0],
		).toEqual({
			current_user: role,
			session_user: role,
			rolsuper: false,
			rolbypassrls: false,
			rolinherit: false,
			rolcanlogin: true,
			memberships: 0,
			owned: 0,
		});
		expect(
			(
				await runtime.query(
					"select relrowsecurity,relforcerowsecurity from pg_class where oid='public_api_request'::regclass",
				)
			).rows[0],
		).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
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
			"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Original','a0'),($4,$5,$6,'Hidden','a0')",
			[existingList, workspace, alice, hiddenList, hidden, outsider],
		);
		await admin.query(
			"insert into label(id,workspace_id,name,color) values($1,$2,'Visible','red'),($3,$4,'Hidden','blue')",
			[label, workspace, hiddenLabel, hidden],
		);
		await admin.query('update "user" set name=$1 where id=any($2::text[])', [
			"Alex",
			[bob, outsider],
		]);
		token = (
			await createPersonalAccessToken(runtime, alice, {
				name: "client writer",
				access: "write",
			})
		).token;
		bobToken = (
			await createPersonalAccessToken(runtime, bob, {
				name: "member writer",
				access: "write",
			})
		).token;
		readToken = (
			await createPersonalAccessToken(runtime, bob, { name: "reader" })
		).token;
		await new Promise<void>((resolve, reject) => {
			api.once("error", reject);
			api.listen(0, "127.0.0.1", resolve);
		});
		listening = true;
		const address = api.address();
		if (!address || typeof address === "string")
			throw new Error("Owned listener unavailable");
		origin = `http://127.0.0.1:${address.port}`;
	}),
);
afterAll(async () => {
	const errors: unknown[] = [];
	async function attempt(fn: () => Promise<unknown>) {
		try {
			await fn();
		} catch (error) {
			errors.push(error);
		}
	}
	for (const child of children) await attempt(() => reap(child));
	for (const client of clients) await attempt(() => client.close());
	if (listening) {
		api.closeAllConnections();
		await attempt(
			() =>
				new Promise<void>((resolve, reject) =>
					api.close((error) => (error ? reject(error) : resolve())),
				),
		);
	}
	for (const [sql, values] of [
		[
			"delete from attachment where id=any($1::text[]) and workspace_id=$2 and uploaded_by=$3",
			[[`${prefix}_committed`, `${prefix}_pending`], workspace, alice],
		],
		[
			"delete from task where list_id in(select id from list where workspace_id=any($1::text[]))",
			[[workspace, hidden]],
		],
		[
			"delete from list where workspace_id=any($1::text[])",
			[[workspace, hidden]],
		],
		[
			"delete from membership where id=any($1::text[]) and user_id=any($2::text[]) and workspace_id=any($3::text[])",
			[
				[`${prefix}_owner`, `${prefix}_member`, `${prefix}_other`],
				[alice, bob, outsider],
				[workspace, hidden],
			],
		],
		[
			"delete from label where workspace_id=any($1::text[])",
			[[workspace, hidden]],
		],
		["delete from workspace where id=any($1::text[])", [[workspace, hidden]]],
		['delete from "user" where id=any($1::text[])', [[alice, bob, outsider]]],
	] as const)
		await attempt(() => admin.query(sql, [...values]));
	await attempt(() => runtime.end());
	if (roleCreated) {
		await attempt(() =>
			admin.query(
				`revoke all privileges on all tables in schema public from "${role}"`,
			),
		);
		await attempt(() =>
			admin.query(`revoke all privileges on schema public from "${role}"`),
		);
		await attempt(() => admin.query(`drop role "${role}"`));
	}
	await attempt(async () => {
		expect(
			(
				await admin.query(
					'select (select count(*)::int from pg_roles where rolname=$1) as roles,(select count(*)::int from pg_stat_activity where usename=$1) as sessions,(select count(*)::int from workspace where id=any($2::text[])) as workspaces,(select count(*)::int from public_api_request where user_id=any($3::text[])) as receipts,(select count(*)::int from "user" where id=any($3::text[])) as users,(select count(*)::int from list where workspace_id=any($2::text[])) as lists,(select count(*)::int from label where workspace_id=any($2::text[])) as labels,(select count(*)::int from task where id like $4) as tasks,(select count(*)::int from task_assignee where task_id like $4) as assignees,(select count(*)::int from task_label where task_id like $4) as task_labels',
					[role, [workspace, hidden], [alice, bob, outsider], `${prefix}_%`],
				)
			).rows[0],
		).toEqual({
			roles: 0,
			sessions: 0,
			workspaces: 0,
			receipts: 0,
			users: 0,
			lists: 0,
			labels: 0,
			tasks: 0,
			assignees: 0,
			task_labels: 0,
		});
	});
	await attempt(async () => {
		expect(children.size).toBe(0);
	});
	await attempt(() => admin.end());
	if (errors.length)
		throw new AggregateError(
			[...causes, ...errors],
			"Client task comments fixture cleanup failed",
			{ cause: causes[0] ?? errors[0] },
		);
});
async function cli(
	command: string,
	args: string[],
	input: unknown,
	secret = token,
) {
	const child = spawn(
		"bun",
		[
			"run",
			fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url)),
			command,
			...args,
			"--json",
			"--allow-loopback-http",
		],
		{
			env: { PATH: process.env.PATH, DITERO_URL: origin, DITERO_TOKEN: secret },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	children.add(child);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (b) => {
		stdout += b;
	});
	child.stderr.on("data", (b) => {
		stderr += b;
	});

	let stdinFailure: unknown;
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") stdinFailure = error;
	});
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			children.delete(child);
			stdinFailure ? reject(stdinFailure) : resolve(code);
		});
	});
	child.stdin.end(
		input instanceof Uint8Array
			? input
			: input === undefined
				? undefined
				: JSON.stringify(input),
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let exit: number | null;
	try {
		exit = await Promise.race([
			closed,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Owned CLI protocol deadline exceeded")),
					18000,
				);
			}),
		]);
	} catch (error) {
		try {
			await reap(child);
		} catch (cleanupError) {
			throw new AggregateError(
				[error, cleanupError],
				"CLI failure and cleanup failure",
				{ cause: error },
			);
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}

	expect(stdout + stderr).not.toContain(secret);
	return { exit, stdout, stderr };
}
async function mcp(secret = token) {
	const transport = new StdioClientTransport({
		command: "bun",
		args: [
			"run",
			fileURLToPath(new URL("../../src/mcp/index.ts", import.meta.url)),
			"--allow-loopback-http",
		],
		env: { DITERO_URL: origin, DITERO_TOKEN: secret },
		stderr: "pipe",
	});
	let stderr = "";
	transport.stderr?.on("data", (b: Buffer) => {
		stderr += b.toString();
	});
	const client = new Client(
		{ name: "client-task-comments-qualification", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	clients.push(client);
	await client.connect(transport);
	return { client, stderr: () => stderr };
}
function toolData(value: unknown): unknown {
	return z
		.object({ version: z.literal(1), data: z.unknown(), nextCursor: z.null() })
		.strict()
		.parse(value).data;
}
async function receiptCount() {
	return (
		await admin.query(
			"select count(*)::int as count from public_api_request where user_id=any($1::text[])",
			[[alice, bob]],
		)
	).rows[0].count;
}

async function task(id: string) {
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Comment task','a0')",
		[id, existingList],
	);
}
async function createInput(id: string, body = "  hello @Alex\n") {
	const observed = await cli("observe-task", ["--task", id], undefined);
	expect(observed.exit).toBe(0);
	return {
		workspaceId: workspace,
		listId: existingList,
		expectedTaskState: JSON.parse(observed.stdout).data.stateToken as string,
		body,
	};
}
async function observe(id: string, commentId: string, secret = readToken) {
	const result = await cli(
		"observe-comment",
		["--task", id, "--comment", commentId],
		undefined,
		secret,
	);
	expect(result.exit).toBe(0);
	return apiCommentObservationSchema.parse(JSON.parse(result.stdout).data);
}
function ack(result: Awaited<ReturnType<Client["callTool"]>>) {
	expect(result.isError).not.toBe(true);
	expect(result.content).toEqual([
		{ type: "text", text: JSON.stringify(result.structuredContent) },
	]);
	return apiCommentAckSchema.parse(toolData(result.structuredContent));
}
test(
	"actual CLI/MCP five-operation journey preserves body, original scope and creation-only member mention",
	() =>
		preserveCause(async () => {
			const id = `${prefix}_journey`;
			await task(id);
			const input = await createInput(id),
				key = randomUUID(),
				before = requests.length,
				noticeBefore = notices.length;
			const created = await cli(
				"add-comment",
				["--task", id, "--request-id", key],
				input,
			);
			expect(created.exit).toBe(0);
			const original = apiCommentAckSchema.parse(
					JSON.parse(created.stdout).data,
				),
				commentId = original.snapshot.commentId;
			expect(original.snapshot.body).toBe(input.body);
			expect(requests.slice(before).map((row) => row.method)).toEqual(["POST"]);
			expect(notices.slice(noticeBefore)).toEqual([
				expect.objectContaining({
					recipientUserId: bob,
					event: expect.objectContaining({
						kind: "mention",
						taskId: id,
						commentId,
						actorUserId: alice,
					}),
				}),
			]);
			const listed = await cli(
				"list-task-comments",
				["--task", id, "--limit", "1"],
				undefined,
				readToken,
			);
			expect(listed.exit).toBe(0);
			expect(JSON.parse(listed.stdout).data).toEqual([original.snapshot]);
			const observed = await observe(id, commentId),
				{ client } = await mcp();
			const editedBody = "  edited @Alex\n",
				update = {
					workspaceId: workspace,
					listId: existingList,
					expectedState: observed.stateToken,
					body: editedBody,
				};
			const editStart = requests.length;
			const edited = ack(
				await client.callTool({
					name: "update_task_comment",
					arguments: {
						taskId: id,
						commentId,
						requestId: randomUUID(),
						comment: update,
					},
				}),
			);
			expect(edited.snapshot.body).toBe(editedBody);
			expect(requests.slice(editStart).map((row) => row.method)).toEqual([
				"PATCH",
			]);
			const next = ackObservation(
				await client.callTool({
					name: "get_comment_observation",
					arguments: { taskId: id, commentId },
				}),
			);
			for (const [attachmentId, state] of [
				[`${prefix}_committed`, "committed"],
				[`${prefix}_pending`, "reserved"],
			]) {
				await admin.query(
					"insert into attachment(id,workspace_id,parent_kind,parent_id,key_version,state,filename_ciphertext,content_type_ciphertext,dek_wrapped,declared_bytes,observed_bytes,ciphertext_sha256,storage_key,uploaded_by,committed_at) values($1,$2,'comment',$3,1,$4,'name','type','dek',4,4,$5,$6,$7,now())",
					[
						attachmentId,
						workspace,
						commentId,
						state,
						"a".repeat(64),
						`${workspace}/${attachmentId}/content`,
						alice,
					],
				);
			}
			const deletion = {
					workspaceId: workspace,
					listId: existingList,
					expectedState: next.stateToken,
					deleteScope: "comment-and-attachments",
				},
				deleteKey = randomUUID();
			const deleted = ack(
				await client.callTool({
					name: "delete_task_comment",
					arguments: {
						taskId: id,
						commentId,
						requestId: deleteKey,
						comment: deletion,
					},
				}),
			);
			expect(deleted.kind).toBe("comment-delete-ack");
			expect(
				(
					await admin.query(
						"select id,state,deleted_at is not null as deleted from attachment where id=any($1::text[]) order by id",
						[[`${prefix}_committed`, `${prefix}_pending`]],
					)
				).rows,
			).toEqual([
				{ id: `${prefix}_committed`, state: "deleting", deleted: true },
				{ id: `${prefix}_pending`, state: "reserved", deleted: false },
			]);
			expect(deleted.snapshot.body).toEqual({
				sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
				utf8Bytes: Buffer.byteLength(editedBody),
			});
			expect(
				(
					await admin.query(
						"select count(*)::int count from comment where id=$1",
						[commentId],
					)
				).rows[0].count,
			).toBe(0);
			await admin.query(
				"insert into comment(id,task_id,author_id,body) values($1,$2,$3,'Replacement')",
				[commentId, id, alice],
			);
			const replay = ack(
				await client.callTool({
					name: "delete_task_comment",
					arguments: {
						taskId: id,
						commentId,
						requestId: deleteKey,
						comment: deletion,
					},
				}),
			);
			expect(replay).toEqual(deleted);
			expect(
				(await admin.query("select body from comment where id=$1", [commentId]))
					.rows[0].body,
			).toBe("Replacement");
			expect(notices).toHaveLength(noticeBefore + 1);
		}),
	30000,
);
function ackObservation(result: Awaited<ReturnType<Client["callTool"]>>) {
	expect(result.isError).not.toBe(true);
	return apiCommentObservationSchema.parse(toolData(result.structuredContent));
}
test(
	"lost committed create reply permits exact MCP retry and cross-operation UUID conflicts",
	() =>
		preserveCause(async () => {
			const id = `${prefix}_lost`;
			await task(id);
			const input = await createInput(id),
				key = randomUUID(),
				before = await receiptCount(),
				start = requests.length,
				noticeBefore = notices.length;
			dropKey = key;
			const lost = await cli(
				"add-comment",
				["--task", id, "--request-id", key],
				input,
			);
			expect(lost.exit).toBe(7);
			expect(dropped.at(-1)).toEqual({ key, status: 200 });
			expect(requests.slice(start)).toHaveLength(1);
			const { client } = await mcp();
			const replay = ack(
				await client.callTool({
					name: "create_task_comment",
					arguments: { taskId: id, requestId: key, comment: input },
				}),
			);
			expect(requests.slice(start)).toHaveLength(2);
			expect(requests[start + 1]).toEqual(requests[start]);
			expect(await receiptCount()).toBe(before + 1);
			expect(notices).toHaveLength(noticeBefore + 1);
			const observation = await observe(id, replay.snapshot.commentId);
			const conflict = await cli(
				"edit-comment",
				[
					"--task",
					id,
					"--comment",
					replay.snapshot.commentId,
					"--request-id",
					key,
				],
				{
					workspaceId: workspace,
					listId: existingList,
					expectedState: observation.stateToken,
					body: "Different",
				},
			);
			expect(conflict.exit).toBe(10);
			expect(await receiptCount()).toBe(before + 1);
		}),
	30000,
);
test(
	"read token and unrelated native author refuse; stale observation has no receipt/effect",
	() =>
		preserveCause(async () => {
			const id = `${prefix}_authority`;
			await task(id);
			const input = await createInput(id),
				before = await receiptCount();
			const denied = await cli(
				"add-comment",
				["--task", id, "--request-id", randomUUID()],
				input,
				readToken,
			);
			expect(denied.exit).toBe(4);
			expect(await receiptCount()).toBe(before);
			const created = await cli(
				"add-comment",
				["--task", id, "--request-id", randomUUID()],
				input,
			);
			expect(created.exit).toBe(0);
			const original = apiCommentAckSchema.parse(
					JSON.parse(created.stdout).data,
				),
				commentId = original.snapshot.commentId;
			const observation = await observe(id, commentId),
				update = {
					workspaceId: workspace,
					listId: existingList,
					expectedState: observation.stateToken,
					body: "New",
				};
			const memberDenied = await cli(
				"edit-comment",
				["--task", id, "--comment", commentId, "--request-id", randomUUID()],
				update,
				bobToken,
			);
			expect(memberDenied.exit).toBe(4);
			await admin.query("update comment set body='Concurrent' where id=$1", [
				commentId,
			]);
			const stale = await cli(
				"edit-comment",
				["--task", id, "--comment", commentId, "--request-id", randomUUID()],
				update,
			);
			expect(stale.exit).toBe(10);
			expect(await receiptCount()).toBe(before + 1);
			expect(
				(await admin.query("select body from comment where id=$1", [commentId]))
					.rows[0].body,
			).toBe("Concurrent");
		}),
	30000,
);
test(
	"original-workspace membership removal denies immutable replay and outsider task read",
	() =>
		preserveCause(async () => {
			const id = `${prefix}_membership`;
			await task(id);
			const input = await createInput(id, "Member comment"),
				key = randomUUID();
			const created = await cli(
				"add-comment",
				["--task", id, "--request-id", key],
				input,
				bobToken,
			);
			expect(created.exit).toBe(0);
			const before = await receiptCount();
			await admin.query(
				"delete from membership where id=$1 and user_id=$2 and workspace_id=$3",
				[`${prefix}_member`, bob, workspace],
			);
			try {
				const { client } = await mcp(bobToken);
				const result = await client.callTool({
					name: "create_task_comment",
					arguments: { taskId: id, requestId: key, comment: input },
				});
				expect(result.isError).toBe(true);
				expect(await receiptCount()).toBe(before);
			} finally {
				await admin.query(
					"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'member')",
					[`${prefix}_member`, bob, workspace],
				);
			}
			const hiddenTask = `${prefix}_hidden_task`;
			await admin.query(
				"insert into task(id,list_id,title,sort_key) values($1,$2,'Hidden','a0')",
				[hiddenTask, hiddenList],
			);
			const hiddenRead = await cli(
				"list-task-comments",
				["--task", hiddenTask],
				undefined,
				readToken,
			);
			expect(hiddenRead.exit).toBe(5);
			expect(hiddenRead.stdout).toBe("");
		}),
	30000,
);
