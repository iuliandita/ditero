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
	apiListDeleteAckSchema,
	apiListDeletionObservationSchema,
} from "../../src/domain/public-api-list-deletion.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_CLIENT_LIST_DELETION_TEST_DATABASE ?? "ditero_e2e";
if (
	process.env.NODE_ENV !== "test" ||
	!databaseURL ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error("Explicit test database and NODE_ENV=test are required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `client_list_delete_${randomUUID().replaceAll("-", "")}`,
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
	existingList = `${prefix}_existing`;
const app = publicApiRoutes(runtime, async () => true);
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
					"select current_user,session_user,rolsuper,rolbypassrls,rolinherit,rolcanlogin,(select count(*)::int from pg_auth_members where member=r.oid) as memberships,(select count(*)::int from pg_class where relowner=r.oid) as owned from pg_roles r where rolname=current_user",
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
			"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Original','a0')",
			[existingList, workspace, alice],
		);
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
			"delete from task where list_id in(select id from list where workspace_id=any($1::text[]))",
			[[workspace, hidden]],
		],
		[
			"delete from list where workspace_id=any($1::text[])",
			[[workspace, hidden]],
		],
		[
			"delete from membership where workspace_id=any($1::text[])",
			[[workspace, hidden]],
		],
		["delete from workspace where id=any($1::text[])", [[workspace, hidden]]],
		['delete from "user" where id=any($1::text[])', [[alice, bob, outsider]]],
	] as const)
		await attempt(() => admin.query(sql, [...values]));
	await attempt(() => runtime.end());
	if (roleCreated) {
		await attempt(() => admin.query(`drop owned by "${role}"`));
		await attempt(() => admin.query(`drop role "${role}"`));
	}
	await attempt(async () => {
		expect(
			(
				await admin.query(
					'select (select count(*)::int from pg_roles where rolname=$1) as roles,(select count(*)::int from pg_stat_activity where usename=$1) as sessions,(select count(*)::int from workspace where id=any($2::text[])) as workspaces,(select count(*)::int from public_api_request where user_id=any($3::text[])) as receipts,(select count(*)::int from "user" where id=any($3::text[])) as users',
					[role, [workspace, hidden], [alice, bob, outsider]],
				)
			).rows[0],
		).toEqual({ roles: 0, sessions: 0, workspaces: 0, receipts: 0, users: 0 });
	});
	await attempt(async () => {
		expect(children.size).toBe(0);
	});
	await attempt(() => admin.end());
	if (errors.length)
		throw new AggregateError(
			[...causes, ...errors],
			"Client list deletion fixture cleanup failed",
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
		{ name: "client-list-deletion-qualification", version: "1" },
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

async function observe(id: string, secret = token) {
	const result = await cli(
		"observe-list-deletion",
		["--list", id],
		undefined,
		secret,
	);
	expect(result.exit).toBe(0);
	return apiListDeletionObservationSchema.parse(JSON.parse(result.stdout).data);
}
function body(
	observation: ReturnType<typeof apiListDeletionObservationSchema.parse>,
	cascadeTasks: boolean,
) {
	return {
		workspaceId: observation.snapshot.workspaceId,
		expectedState: observation.stateToken,
		expectedTasksState: observation.tasksState,
		cascadeTasks,
	};
}
test(
	"actual empty deletion commits before lost response and exact cross-client replay preserves a foreign replacement",
	async () =>
		preserveCause(async () => {
			const observation = await observe(existingList, readToken);
			expect(observation.tasksState.count).toBe(0);
			const deletion = body(observation, false),
				key = randomUUID();
			const noncreator = await cli(
				"delete-list",
				["--list", existingList, "--request-id", randomUUID()],
				deletion,
				bobToken,
			);
			expect(noncreator.exit).toBe(4);
			expect(await receiptCount()).toBe(0);
			const before = requests.length;
			dropKey = key;
			const failed = await cli(
				"delete-list",
				["--list", existingList, "--request-id", key],
				deletion,
			);
			expect(failed.exit).toBe(7);
			expect(failed.stdout).toBe("");
			expect(dropped).toEqual([{ key, status: 200 }]);
			expect(requests.slice(before)).toHaveLength(1);
			expect(requests[before].method).toBe("DELETE");
			expect(await receiptCount()).toBe(1);
			expect(
				(
					await admin.query(
						"select count(*)::int as count from list where id=$1",
						[existingList],
					)
				).rows[0].count,
			).toBe(0);
			await admin.query(
				"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Foreign replacement','a0')",
				[existingList, hidden, outsider],
			);
			const writer = await mcp();
			const replay = await writer.client.callTool({
				name: "delete_list",
				arguments: { listId: existingList, requestId: key, deletion },
			});
			expect(replay.isError).not.toBe(true);
			const ack = apiListDeleteAckSchema.parse(
				toolData(replay.structuredContent),
			);
			expect(ack).toEqual({
				kind: "list-delete-ack",
				snapshot: observation.snapshot,
				deletedTasks: 0,
			});
			expect(requests[before + 1]).toEqual(requests[before]);
			expect(await receiptCount()).toBe(1);
			expect(
				(
					await admin.query("select title,workspace_id from list where id=$1", [
						existingList,
					])
				).rows[0],
			).toEqual({ title: "Foreign replacement", workspace_id: hidden });
			const conflicting = await writer.client.callTool({
				name: "delete_list",
				arguments: {
					listId: existingList,
					requestId: key,
					deletion: { ...deletion, cascadeTasks: true },
				},
			});
			expect(conflicting.structuredContent).toMatchObject({
				error: { status: 409 },
			});
			expect(
				(
					await cli(
						"delete-list",
						["--list", existingList, "--request-id", key],
						deletion,
						readToken,
					)
				).exit,
			).toBe(4);
			expect(writer.stderr()).toBe("");
			expect(failures).toEqual([]);
		}),
	20000,
);
test(
	"actual creator cascade requires complete fresh evidence and never hides reads or retries",
	async () =>
		preserveCause(async () => {
			const listId = `${prefix}_cascade`,
				taskId = `${prefix}_task`,
				childId = `${prefix}_child`;
			await admin.query(
				"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Cascade','a1')",
				[listId, workspace, bob],
			);
			await admin.query(
				"insert into task(id,list_id,title,sort_key) values($1,$2,'Parent','a0')",
				[taskId, listId],
			);
			await admin.query(
				"insert into task(id,list_id,parent_id,title,sort_key) values($1,$2,$3,'Child','a1')",
				[childId, listId, taskId],
			);
			const observation = await observe(listId, readToken);
			expect(observation.tasksState.count).toBe(2);
			const writer = await mcp(bobToken),
				reader = await mcp(readToken);
			const beforeReceipts = await receiptCount();
			let before = requests.length;
			const refused = await writer.client.callTool({
				name: "delete_list",
				arguments: {
					listId,
					requestId: randomUUID(),
					deletion: body(observation, false),
				},
			});
			expect(refused.structuredContent).toMatchObject({
				error: { status: 409 },
			});
			expect(requests.slice(before).map((r) => r.method)).toEqual(["DELETE"]);
			expect(await receiptCount()).toBe(beforeReceipts);
			await admin.query("update task set title='Changed child' where id=$1", [
				childId,
			]);
			const stale = await cli(
				"delete-list",
				["--list", listId, "--request-id", randomUUID()],
				body(observation, true),
				bobToken,
			);
			expect(stale.exit).toBe(10);
			expect(JSON.parse(stale.stderr)).toMatchObject({
				error: { code: "request_conflict", status: 409 },
			});
			expect(
				(
					await admin.query(
						"select count(*)::int as count from task where list_id=$1",
						[listId],
					)
				).rows[0].count,
			).toBe(2);
			const fresh = await observe(listId);
			expect(fresh.tasksState.token).not.toBe(observation.tasksState.token);
			const deletion = body(fresh, true),
				key = randomUUID();
			expect(
				(
					await reader.client.callTool({
						name: "delete_list",
						arguments: { listId, requestId: key, deletion },
					})
				).structuredContent,
			).toMatchObject({ error: { status: 403 } });
			before = requests.length;
			const deleted = await writer.client.callTool({
				name: "delete_list",
				arguments: { listId, requestId: key, deletion },
			});
			expect(deleted.isError).not.toBe(true);
			const ack = apiListDeleteAckSchema.parse(
				toolData(deleted.structuredContent),
			);
			expect(ack).toEqual({
				kind: "list-delete-ack",
				snapshot: fresh.snapshot,
				deletedTasks: 2,
			});
			expect(requests.slice(before).map((r) => r.method)).toEqual(["DELETE"]);
			expect(await receiptCount()).toBe(beforeReceipts + 1);
			expect(
				(
					await admin.query(
						"select count(*)::int as count from task where id=any($1::text[])",
						[[taskId, childId]],
					)
				).rows[0].count,
			).toBe(0);
			expect(
				JSON.parse(
					(
						await cli(
							"delete-list",
							["--list", listId, "--request-id", key],
							deletion,
							bobToken,
						)
					).stdout,
				).data,
			).toEqual(ack);
			await admin.query(
				"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
				[bob, workspace],
			);
			expect(
				(
					await writer.client.callTool({
						name: "delete_list",
						arguments: { listId, requestId: key, deletion },
					})
				).structuredContent,
			).toMatchObject({ error: { status: 403 } });
			await admin.query(
				"delete from membership where user_id=$1 and workspace_id=$2",
				[bob, workspace],
			);
			expect(
				(
					await writer.client.callTool({
						name: "delete_list",
						arguments: { listId, requestId: key, deletion },
					})
				).structuredContent,
			).toMatchObject({ error: { status: 404 } });
			expect(writer.stderr()).toBe("");
			expect(reader.stderr()).toBe("");
			expect(failures).toEqual([]);
		}),
	20000,
);
