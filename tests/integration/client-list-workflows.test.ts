import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { z } from "zod";
import journal from "../../drizzle/meta/_journal.json";
import { apiListCreationAckSchema } from "../../src/domain/public-api-list-create.ts";
import {
	apiListObservationSchema,
	apiListUpdateAckSchema,
} from "../../src/domain/public-api-list-update.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_CLIENT_LIST_TEST_DATABASE ?? "ditero_e2e";
if (
	process.env.NODE_ENV !== "test" ||
	!databaseURL ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error("Explicit test database and NODE_ENV=test are required");
const admin = new Pool({ connectionString: databaseURL });
const prefix = `client_list_${randomUUID().replaceAll("-", "")}`,
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
beforeAll(async () => {
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
});
afterAll(async () => {
	const errors: unknown[] = [];
	async function attempt(fn: () => Promise<unknown>) {
		try {
			await fn();
		} catch (error) {
			errors.push(error);
		}
	}
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
			"delete from folder where workspace_id=any($1::text[])",
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
	await attempt(() => admin.end());
	if (errors.length)
		throw new AggregateError(errors, "Client list fixture cleanup failed");
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
	let stdout = "",
		stderr = "";
	child.stdout.on("data", (b) => {
		stdout += b;
	});
	child.stderr.on("data", (b) => {
		stderr += b;
	});
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") throw error;
	});
	child.stdin.end(
		input instanceof Uint8Array
			? input
			: input === undefined
				? undefined
				: JSON.stringify(input),
	);
	const exit = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", resolve);
	});
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
		{ name: "client-list-qualification", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	await client.connect(transport);
	clients.push(client);
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

test("actual CLI/MCP protocol qualifies observed native member writes, immutable replay and current authority", async () => {
	const placementFolder = `${prefix}_placement_folder`;
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Placement','a0')",
		[placementFolder, workspace],
	);
	const member = await mcp(bobToken);
	const observed = await member.client.callTool({
		name: "get_list_observation",
		arguments: { listId: existingList },
	});
	expect(observed.isError).not.toBe(true);
	const observation = apiListObservationSchema.parse(
		toolData(observed.structuredContent),
	);
	const body = {
		workspaceId: workspace,
		expectedState: observation.stateToken,
		patch: {
			title: "Edited",
			icon: "star",
			completedDisplay: "hide",
			folderId: placementFolder,
			sortKey: "a1xyz",
		},
	};
	const key = randomUUID();
	let before = requests.length;
	const changed = await cli(
		"update-list",
		["--list", existingList, "--request-id", key],
		body,
		bobToken,
	);
	expect(changed.exit).toBe(0);
	expect(requests.slice(before).map((r) => [r.method, r.path])).toEqual([
		["PATCH", `/api/v1/lists/${existingList}`],
	]);
	const ack = apiListUpdateAckSchema.parse(JSON.parse(changed.stdout).data);
	expect(ack.snapshot).toMatchObject({
		id: existingList,
		ownerId: alice,
		title: "Edited",
		icon: "star",
		completedDisplay: "hide",
		folderId: placementFolder,
		sortKey: "a1xyz",
	});
	expect(await receiptCount()).toBe(1);
	before = requests.length;
	const stale = await member.client.callTool({
		name: "update_list",
		arguments: { listId: existingList, requestId: randomUUID(), update: body },
	});
	expect(stale.isError).toBe(true);
	expect(stale.structuredContent).toMatchObject({ error: { status: 409 } });
	expect(requests.slice(before).map((r) => r.method)).toEqual(["PATCH"]);
	expect(await receiptCount()).toBe(1);
	await admin.query("update list set title='Later' where id=$1", [
		existingList,
	]);
	const replay = await member.client.callTool({
		name: "update_list",
		arguments: { listId: existingList, requestId: key, update: body },
	});
	expect(toolData(replay.structuredContent)).toEqual(ack);
	expect(
		(await admin.query("select title from list where id=$1", [existingList]))
			.rows[0].title,
	).toBe("Later");
	const reader = await mcp(readToken);
	expect(
		(
			await reader.client.callTool({
				name: "get_list_observation",
				arguments: { listId: existingList },
			})
		).isError,
	).not.toBe(true);
	expect(
		(
			await reader.client.callTool({
				name: "update_list",
				arguments: { listId: existingList, requestId: key, update: body },
			})
		).structuredContent,
	).toMatchObject({ error: { status: 403 } });
	await admin.query("delete from list where id=$1", [existingList]);
	expect(
		JSON.parse(
			(
				await cli(
					"update-list",
					["--list", existingList, "--request-id", key],
					body,
					bobToken,
				)
			).stdout,
		).data,
	).toEqual(ack);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Replacement','a0')",
		[existingList, hidden, outsider],
	);
	expect(
		toolData(
			(
				await member.client.callTool({
					name: "update_list",
					arguments: { listId: existingList, requestId: key, update: body },
				})
			).structuredContent,
		),
	).toEqual(ack);
	expect(
		(await admin.query("select title from list where id=$1", [existingList]))
			.rows[0].title,
	).toBe("Replacement");
	await admin.query(
		"update membership set role='viewer' where user_id=$1 and workspace_id=$2",
		[bob, workspace],
	);
	expect(
		(
			await cli(
				"update-list",
				["--list", existingList, "--request-id", key],
				body,
				bobToken,
			)
		).exit,
	).toBe(4);
	await admin.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[bob, workspace],
	);
	expect(
		(
			await member.client.callTool({
				name: "update_list",
				arguments: { listId: existingList, requestId: key, update: body },
			})
		).structuredContent,
	).toMatchObject({ error: { status: 404 } });
	expect(member.stderr()).toBe("");
	expect(reader.stderr()).toBe("");
	expect(failures).toEqual([]);
}, 20000);
test("actual creation commits before a dropped response and exact cross-client manual retry never duplicates", async () => {
	const key = randomUUID(),
		body = {
			workspaceId: workspace,
			title: "Groceries",
			kind: "shopping",
			icon: null,
		};
	const before = requests.length;
	dropKey = key;
	const failed = await cli("create-list", ["--request-id", key], body);
	expect(failed.exit).toBe(7);
	expect(failed.stdout).toBe("");
	expect(dropped).toEqual([{ key, status: 201 }]);
	expect(requests.slice(before)).toHaveLength(1);
	const count = await receiptCount();
	const writer = await mcp();
	const replay = await writer.client.callTool({
		name: "create_list",
		arguments: { requestId: key, list: body },
	});
	expect(replay.isError).not.toBe(true);
	const ack = apiListCreationAckSchema.parse(
		toolData(replay.structuredContent),
	);
	expect(ack.snapshot).toMatchObject({
		workspaceId: workspace,
		ownerId: alice,
		title: "Groceries",
		kind: "shopping",
	});
	expect(requests[before]).toEqual(requests[before + 1]);
	expect(await receiptCount()).toBe(count);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from list where workspace_id=$1 and title='Groceries'",
				[workspace],
			)
		).rows[0].count,
	).toBe(1);
	await admin.query("update list set title='Later' where id=$1", [
		ack.snapshot.id,
	]);
	expect(
		JSON.parse((await cli("create-list", ["--request-id", key], body)).stdout)
			.data,
	).toEqual(ack);
	await admin.query("delete from list where id=$1", [ack.snapshot.id]);
	expect(
		JSON.parse((await cli("create-list", ["--request-id", key], body)).stdout)
			.data,
	).toEqual(ack);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Foreign replacement','a0')",
		[ack.snapshot.id, hidden, outsider],
	);
	expect(
		toolData(
			(
				await writer.client.callTool({
					name: "create_list",
					arguments: { requestId: key, list: body },
				})
			).structuredContent,
		),
	).toEqual(ack);
	expect(
		(await admin.query("select title from list where id=$1", [ack.snapshot.id]))
			.rows[0].title,
	).toBe("Foreign replacement");
	await admin.query(
		"delete from membership where user_id=$1 and workspace_id=$2",
		[alice, workspace],
	);
	expect(
		(
			await writer.client.callTool({
				name: "create_list",
				arguments: { requestId: key, list: body },
			})
		).structuredContent,
	).toMatchObject({ error: { status: 404 } });

	const read = await cli(
		"create-list",
		["--request-id", randomUUID()],
		body,
		readToken,
	);
	expect(read.exit).toBe(4);
	const n = requests.length;
	for (const raw of [new Uint8Array([255]), new Uint8Array(4097)])
		expect(
			(await cli("create-list", ["--request-id", randomUUID()], raw)).exit,
		).toBe(2);
	expect(requests).toHaveLength(n);
	expect(writer.stderr()).toBe("");
	expect(failures).toEqual([]);
}, 20000);
