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
	apiTaskPlacementAckSchema,
	apiTaskPlacementObservationSchema,
} from "../../src/domain/public-api-task-placement.ts";
import type { CollectedEvent } from "../../src/server/notifications/events.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_CLIENT_TASK_PLACEMENT_TEST_DATABASE ?? "ditero_e2e";
if (
	process.env.NODE_ENV !== "test" ||
	!databaseURL ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error("Explicit test database and NODE_ENV=test are required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `client_placement_${randomUUID().replaceAll("-", "")}`,
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
const notices: CollectedEvent["event"][] = [];
const app = publicApiRoutes(
	runtime,
	async () => true,
	async (events) => {
		expect(await receiptCount()).toBeGreaterThan(0);
		for (const entry of events) notices.push(entry.event);
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
			"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Original','a0'),($4,$5,$6,'Hidden','a0')",
			[existingList, workspace, alice, hiddenList, hidden, outsider],
		);
		await admin.query(
			"insert into label(id,workspace_id,name,color) values($1,$2,'Visible','red'),($3,$4,'Hidden','blue')",
			[label, workspace, hiddenLabel, hidden],
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
		await attempt(() => admin.query(`drop owned by "${role}"`));
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
			"Client task placement fixture cleanup failed",
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
		{ name: "client-task-placement-qualification", version: "1" },
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

async function createTask(id: string, childCount = 0) {
	await admin.query(
		"insert into task(id,list_id,title,sort_key) values($1,$2,'Original task','a0')",
		[id, existingList],
	);
	for (let i = 0; i < childCount; i++)
		await admin.query(
			"insert into task(id,list_id,parent_id,title,sort_key) values($1,$2,$3,'Child','a0')",
			[`${id}_child${i}`, existingList, id],
		);
}
async function observe(id: string) {
	const result = await cli(
		"observe-task-placement",
		["--task", id],
		undefined,
		readToken,
	);
	expect(result.exit).toBe(0);
	return apiTaskPlacementObservationSchema.parse(
		JSON.parse(result.stdout).data,
	);
}
async function inputFor(id: string, targetListId = existingList) {
	const observation = await observe(id);
	const target = await cli(
		"observe-list",
		["--list", targetListId],
		undefined,
		readToken,
	);
	expect(target.exit).toBe(0);
	return {
		workspaceId: workspace,
		listId: existingList,
		expectedState: observation.stateToken,
		targetListId,
		expectedTargetState: JSON.parse(target.stdout).data.stateToken as string,
		sortKey: "a1",
		cascadeChildren: targetListId !== existingList,
		expectedChildrenState:
			targetListId === existingList ? null : observation.childrenState,
	};
}
async function target(id: string) {
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Target','a1')",
		[id, workspace, alice],
	);
}
async function position(id: string) {
	return (
		await admin.query(
			"select list_id,sort_key,parent_id from task where id=$1",
			[id],
		)
	).rows[0];
}
function resultData(result: Awaited<ReturnType<Client["callTool"]>>) {
	expect(result.isError).not.toBe(true);
	expect(result.content).toEqual([
		{ type: "text", text: JSON.stringify(result.structuredContent) },
	]);
	return apiTaskPlacementAckSchema.parse(toolData(result.structuredContent));
}

test(
	"CLI ordering and MCP replay use identical one-request placement without reordering a recreated task",
	() =>
		preserveCause(async () => {
			const id = `${prefix}_order`;
			await createTask(id);
			const body = await inputFor(id);
			const key = randomUUID();
			const start = requests.length;
			const applied = await cli(
				"place-task",
				["--task", id, "--request-id", key],
				body,
			);
			expect(applied.exit).toBe(0);
			const ack = apiTaskPlacementAckSchema.parse(
				JSON.parse(applied.stdout).data,
			);
			expect(ack.snapshot.sortKey).toBe("a1");
			expect(ack.movedChildren).toBe(0);
			expect(requests.slice(start).map((r) => r.method)).toEqual(["PATCH"]);
			await admin.query("delete from task where id=$1", [id]);
			await createTask(id);
			const { client } = await mcp();
			const before = requests.length;
			const replay = resultData(
				await client.callTool({
					name: "place_task",
					arguments: { taskId: id, requestId: key, placement: body },
				}),
			);
			expect(replay).toEqual(ack);
			expect(await position(id)).toMatchObject({
				sort_key: "a0",
				list_id: existingList,
			});
			expect(requests.slice(before).map((r) => r.method)).toEqual(["PATCH"]);
		}),
	30000,
);

test(
	"root relocation explicitly moves two children and exact lost-response retry is one original effect",
	() =>
		preserveCause(async () => {
			const id = `${prefix}_move`,
				destination = `${prefix}_target`;
			await target(destination);
			await createTask(id, 2);
			const body = await inputFor(id, destination);
			const key = randomUUID();
			dropKey = key;
			const before = await receiptCount();
			const start = requests.length;
			const lost = await cli(
				"place-task",
				["--task", id, "--request-id", key],
				body,
			);
			expect(lost.exit).toBe(7);
			expect(dropped.at(-1)).toEqual({ key, status: 200 });
			expect(requests.slice(start)).toHaveLength(1);
			const { client } = await mcp();
			const ack = resultData(
				await client.callTool({
					name: "place_task",
					arguments: { taskId: id, requestId: key, placement: body },
				}),
			);
			expect(ack.movedChildren).toBe(2);
			expect(await receiptCount()).toBe(before + 1);
			const sent = requests.slice(start);
			expect(sent).toHaveLength(2);
			expect(sent[1]).toEqual(sent[0]);
			expect(await position(id)).toMatchObject({
				list_id: destination,
				sort_key: "a1",
			});
			for (let i = 0; i < 2; i++)
				expect(await position(`${id}_child${i}`)).toEqual({
					list_id: destination,
					sort_key: "a0",
					parent_id: id,
				});
		}),
	30000,
);

test.each(["task", "target", "child"])(
	"stale %s observation refuses without placement or receipt",
	(changed) =>
		preserveCause(async () => {
			const id = `${prefix}_stale_${changed}`,
				destination = `${prefix}_target_${changed}`;
			await target(destination);
			await createTask(id, 1);
			const body = await inputFor(id, destination);
			const before = await receiptCount();
			if (changed === "target")
				await admin.query(
					"update list set title='Changed target' where id=$1",
					[destination],
				);
			else
				await admin.query("update task set title='Changed task' where id=$1", [
					changed === "child" ? `${id}_child0` : id,
				]);
			const start = requests.length;
			const result = await cli(
				"place-task",
				["--task", id, "--request-id", randomUUID()],
				body,
			);
			expect(result.exit).toBe(10);
			expect(requests.slice(start)).toHaveLength(1);
			expect(await position(id)).toMatchObject({
				list_id: existingList,
				sort_key: "a0",
			});
			expect(await receiptCount()).toBe(before);
		}),
	30000,
);

test(
	"read PAT and removed membership cannot place or replay; changed-body UUID conflicts",
	() =>
		preserveCause(async () => {
			const id = `${prefix}_authority`;
			await createTask(id);
			const body = await inputFor(id);
			const before = await receiptCount();
			const key = randomUUID();
			const denied = await cli(
				"place-task",
				["--task", id, "--request-id", key],
				body,
				readToken,
			);
			expect(denied.exit).toBe(4);
			expect(await receiptCount()).toBe(before);
			const applied = await cli(
				"place-task",
				["--task", id, "--request-id", key],
				body,
				bobToken,
			);
			expect(applied.exit).toBe(0);
			const conflict = await cli(
				"place-task",
				["--task", id, "--request-id", key],
				{ ...body, sortKey: "a2" },
				bobToken,
			);
			expect(conflict.exit).toBe(10);
			await admin.query(
				"delete from membership where workspace_id=$1 and user_id=$2",
				[workspace, bob],
			);
			try {
				const { client } = await mcp(bobToken);
				const result = await client.callTool({
					name: "place_task",
					arguments: { taskId: id, requestId: key, placement: body },
				});
				expect(result.isError).toBe(true);
				expect(await receiptCount()).toBe(before + 1);
				expect(await position(id)).toMatchObject({ sort_key: "a1" });
			} finally {
				await admin.query(
					"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'member')",
					[`${prefix}_member`, bob, workspace],
				);
			}
		}),
	30000,
);
