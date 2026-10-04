import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "vitest";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const role = `client_mutations_${randomUUID().replaceAll("-", "")}`;
const runtimePassword = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = runtimePassword;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
const wires: {
	path: string;
	method: string | undefined;
	key: string | undefined;
	body: string;
}[] = [];
let drop: string | null = null;
let origin: string;
let actor: string;
let workspace: string;
let list: string;
let task: string;
let token: string;
let tokenId: string;
const clients: Client[] = [];
const server = createServer(async (incoming, outgoing) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks).toString();
		const headers = new Headers();
		for (const [key, value] of Object.entries(incoming.headers))
			if (value !== undefined)
				headers.set(key, Array.isArray(value) ? value.join(",") : value);
		wires.push({
			path: incoming.url ?? "",
			method: incoming.method,
			key: headers.get("idempotency-key") ?? undefined,
			body,
		});
		const response = await app.handle(
			new Request(`${origin}${incoming.url}`, {
				method: incoming.method,
				headers,
				...(body ? { body } : {}),
			}),
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (drop === incoming.method) {
			drop = null;
			outgoing.destroy();
			return;
		}
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(bytes);
	} catch {
		outgoing.writeHead(500);
		outgoing.end();
	}
});
beforeAll(async () => {
	await admin.query(
		`create role "${role}" login password '${runtimePassword}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls,session_user=current_user as direct_login from pg_roles where rolname=current_user",
			)
		).rows[0],
	).toEqual({ rolsuper: false, rolbypassrls: false, direct_login: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing fixture listener");
	origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(async () => {
	actor = randomUUID();
	workspace = randomUUID();
	list = randomUUID();
	task = randomUUID();
	wires.length = 0;
	drop = null;
	await admin.query(
		'insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)',
		[actor, "Agent", `${actor}@mutations.test`],
	);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ($1,'Agent fixture',$2,'shared')",
		[workspace, actor],
	);
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,'owner')",
		[randomUUID(), actor, workspace],
	);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,sort_key) values ($1,$2,$3,'Tasks','a0')",
		[list, workspace, actor],
	);
	await admin.query(
		"insert into task (id,list_id,title,sort_key) values ($1,$2,'Task','a0')",
		[task, list],
	);
	const pat = await createPersonalAccessToken(runtime, actor, {
		name: "writer",
		access: "write",
	});
	token = pat.token;
	tokenId = pat.id;
});
afterEach(async () => {
	for (const client of clients.splice(0)) await client.close();
	await admin.query("delete from task where list_id=$1", [list]);
	await admin.query("delete from list where id=$1", [list]);
	await admin.query("delete from membership where workspace_id=$1", [
		workspace,
	]);
	await admin.query("delete from workspace where id=$1", [workspace]);
	await admin.query('delete from "user" where id=$1', [actor]);
});
afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
async function counts() {
	return (
		await admin.query(
			"select (select count(*)::int from task_completion_event where task_id=$1) history,(select count(*)::int from karma_event where user_id=$2) karma,(select count(*)::int from public_api_request where user_id=$2) receipts",
			[task, actor],
		)
	).rows[0];
}
async function cli(
	operation: string,
	body?: unknown,
	key = randomUUID(),
	secret = token,
) {
	const child = spawn(
		"bun",
		[
			"run",
			fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url)),
			operation,
			"--task",
			task,
			...(!operation.startsWith("observe") ? ["--request-id", key] : []),
			"--json",
			"--allow-loopback-http",
		],
		{
			env: { PATH: process.env.PATH, DITERO_URL: origin, DITERO_TOKEN: secret },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
	try {
		child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		return { code, stdout, stderr };
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await new Promise<void>((resolve) =>
				child.once("close", () => resolve()),
			);
		}
	}
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
	transport.stderr?.on("data", () => {});
	const client = new Client(
		{ name: "actual-completion", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	clients.push(client);
	await client.connect(transport);
	return client;
}

async function observation(deleting = false, secret = token) {
	const result = await cli(
		deleting ? "observe-task-deletion" : "observe-task",
		undefined,
		undefined,
		secret,
	);
	expect(result.code).toBe(0);
	return JSON.parse(result.stdout).data;
}
function updateBody(
	observed: { snapshot: { listId: string }; stateToken: string },
	patch: Record<string, unknown>,
) {
	return {
		listId: observed.snapshot.listId,
		expectedState: observed.stateToken,
		patch,
	};
}
function deleteBody(
	observed: {
		snapshot: { listId: string };
		stateToken: string;
		childrenState: unknown;
	},
	cascadeChildren: boolean,
) {
	return {
		listId: observed.snapshot.listId,
		expectedState: observed.stateToken,
		expectedChildrenState: observed.childrenState,
		cascadeChildren,
	};
}
const noEffects = { history: 0, karma: 0, receipts: 0 };
const oneMutation = { history: 0, karma: 0, receipts: 1 };
test("actual CLI updates observed scalars, rejects stale state and cross-operation keys, and replays current/deleted state", async () => {
	await admin.query(
		"update task set notes='Keep',due_at='2026-10-04T10:00:00.000Z',priority=1 where id=$1",
		[task],
	);
	const observed = await observation(),
		body = updateBody(observed, { title: "  العربية  ", notes: null }),
		key = randomUUID();
	const first = await cli("update-task", body, key);
	expect(first.code).toBe(0);
	expect(JSON.parse(first.stdout).data).toMatchObject({
		title: "العربية",
		notes: null,
		dueAt: "2026-10-04T10:00:00.000Z",
		priority: 1,
	});
	expect(await counts()).toEqual(oneMutation);
	expect(wires.map((w) => w.method)).toEqual(["GET", "PATCH"]);
	expect((await cli("update-task", body, randomUUID())).code).toBe(10);
	expect(await counts()).toEqual(oneMutation);
	await admin.query("update task set title='Later' where id=$1", [task]);
	expect(
		JSON.parse((await cli("update-task", body, key)).stdout).data.title,
	).toBe("Later");
	expect(await counts()).toEqual(oneMutation);
	const conflict = await fetch(`${origin}/api/v1/tasks`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			"idempotency-key": key,
		},
		body: JSON.stringify({ listId: list, title: "Cross operation" }),
	});
	expect(conflict.status).toBe(409);
	await admin.query("delete from task where id=$1", [task]);
	expect((await cli("update-task", body, key)).code).toBe(11);
	expect(await counts()).toEqual(oneMutation);
}, 15000);
test("actual CLI deletion binds changed child fields, explicit cascade and original receipt across ID recreation", async () => {
	const child = randomUUID();
	await admin.query(
		"insert into task(id,list_id,parent_id,title,sort_key) values($1,$2,$3,'Child','a1')",
		[child, list, task],
	);
	const initial = await observation(true);
	expect(initial.childrenState.count).toBe(1);
	expect((await cli("delete-task", deleteBody(initial, false))).code).toBe(10);
	expect(await counts()).toEqual(noEffects);
	await admin.query("update task set title='Changed child' where id=$1", [
		child,
	]);
	expect((await cli("delete-task", deleteBody(initial, true))).code).toBe(10);
	expect(await counts()).toEqual(noEffects);
	const observed = await observation(true),
		body = deleteBody(observed, true),
		key = randomUUID();
	const result = await cli("delete-task", body, key);
	expect(result.code).toBe(0);
	const receipt = JSON.parse(result.stdout);
	expect(receipt.data).toEqual({
		taskId: task,
		listId: list,
		deleted: true,
		deletedChildren: 1,
	});
	expect(
		(
			await admin.query("select id from task where id=any($1::text[])", [
				[task, child],
			])
		).rowCount,
	).toBe(0);
	expect(await counts()).toEqual(oneMutation);
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Recreated','a0')",
		[task, list],
	);
	expect(JSON.parse((await cli("delete-task", body, key)).stdout)).toEqual(
		receipt,
	);
	expect(
		(await admin.query("select title from task where id=$1", [task])).rows[0]
			.title,
	).toBe("Recreated");
	expect(await counts()).toEqual(oneMutation);
}, 15000);
test.each([
	"update-task",
	"delete-task",
])("actual CLI %s preserves an uncertain committed result for identical-key/body retry", async (operation) => {
	const observed = await observation(operation === "delete-task"),
		body =
			operation === "update-task"
				? updateBody(observed, { priority: 3 })
				: deleteBody(observed, false),
		key = randomUUID();
	wires.length = 0;
	drop = operation === "update-task" ? "PATCH" : "DELETE";
	expect((await cli(operation, body, key)).code).toBe(7);
	expect(wires).toHaveLength(1);
	expect(await counts()).toEqual(oneMutation);
	expect((await cli(operation, body, key)).code).toBe(0);
	expect(wires).toHaveLength(2);
	expect(wires[0]).toEqual(wires[1]);
	expect(await counts()).toEqual(oneMutation);
}, 15000);
test("actual MCP stdio observes and updates then deletes with a retained original receipt", async () => {
	const client = await mcp();
	const observed = (
		await client.callTool({
			name: "get_task_observation",
			arguments: { taskId: task },
		})
	).structuredContent as {
		data: { snapshot: { listId: string }; stateToken: string };
	};
	const update = updateBody(observed.data, { notes: "MCP note" }),
		key = randomUUID();
	const result = await client.callTool({
		name: "update_task",
		arguments: { taskId: task, requestId: key, update },
	});
	expect(result.isError).not.toBe(true);
	expect(result.structuredContent).toMatchObject({
		data: { id: task, notes: "MCP note" },
	});
	expect(await counts()).toEqual(oneMutation);
	const stale = await client.callTool({
		name: "update_task",
		arguments: { taskId: task, requestId: randomUUID(), update },
	});
	expect(stale.isError).toBe(true);
	expect(stale.structuredContent).toMatchObject({ error: { status: 409 } });
	expect(await counts()).toEqual(oneMutation);
	const deletionObservation = (
		await client.callTool({
			name: "get_task_deletion_observation",
			arguments: { taskId: task },
		})
	).structuredContent as {
		data: {
			snapshot: { listId: string };
			stateToken: string;
			childrenState: unknown;
		};
	};
	const deletion = deleteBody(deletionObservation.data, false),
		deleteKey = randomUUID(),
		args = { taskId: task, requestId: deleteKey, deletion };
	const deleted = await client.callTool({
		name: "delete_task",
		arguments: args,
	});
	expect(deleted.isError).not.toBe(true);
	expect(
		(await client.callTool({ name: "delete_task", arguments: args }))
			.structuredContent,
	).toEqual(deleted.structuredContent);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 2 });
	expect(wires.map((w) => w.method)).toEqual([
		"GET",
		"PATCH",
		"PATCH",
		"GET",
		"DELETE",
		"DELETE",
	]);
}, 15000);
test("actual read PAT and viewer can observe but cannot mutate, and revocation denies observation", async () => {
	const read = await createPersonalAccessToken(runtime, actor, {
		name: "reader",
		access: "read",
	});
	const observed = await observation(false, read.token);
	wires.length = 0;
	expect(
		(
			await cli(
				"update-task",
				updateBody(observed, { title: "Refused" }),
				randomUUID(),
				read.token,
			)
		).code,
	).toBe(4);
	expect(wires).toHaveLength(1);
	expect(await counts()).toEqual(noEffects);
	await admin.query(
		"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
		[actor, workspace],
	);
	const client = await mcp();
	expect(
		(
			await client.callTool({
				name: "get_task_deletion_observation",
				arguments: { taskId: task },
			})
		).isError,
	).not.toBe(true);
	expect(
		(
			await client.callTool({
				name: "update_task",
				arguments: {
					taskId: task,
					requestId: randomUUID(),
					update: updateBody(observed, { title: "Refused" }),
				},
			})
		).structuredContent,
	).toMatchObject({ error: { status: 403 } });
	expect(await counts()).toEqual(noEffects);
	await revokePersonalAccessToken(runtime, actor, tokenId);
	expect((await cli("observe-task")).code).toBe(3);
	expect(await counts()).toEqual(noEffects);
}, 15000);
