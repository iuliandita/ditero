import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import { runCli } from "../../src/cli/index.ts";
import {
	apiFolderCreateAckSchema,
	apiFolderObservationSchema,
} from "../../src/domain/public-api-folder.ts";
import { createDiteroMcp, mcpConfiguration } from "../../src/mcp/server.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import { createPersonalAccessToken } from "../../src/server/public-api/tokens.ts";

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_CLIENT_FOLDER_TEST_DATABASE ?? "ditero_e2e";
if (
	!databaseURL ||
	process.env.NODE_ENV !== "test" ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error(
		"Explicit folder client test database and NODE_ENV=test required",
	);
const prefix = `client_folder_${randomUUID().replaceAll("-", "")}`;
const alice = `${prefix}_alice`,
	bob = `${prefix}_bob`,
	outsider = `${prefix}_outsider`;
const workspace = `${prefix}_workspace`,
	hidden = `${prefix}_hidden`,
	list = `${prefix}_list`;
const role = `${prefix}_runtime`,
	password = randomUUID();
const admin = new Pool({ connectionString: databaseURL });
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
let origin = "",
	token = "",
	bobToken = "",
	bobTokenId = "",
	readToken = "",
	roleCreated = false,
	listening = false;
const failures: unknown[] = [];
const api = createServer(async (incoming, outgoing) => {
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
		const method = incoming.method ?? "GET";
		const response = await app.handle(
			new Request(new URL(incoming.url ?? "/", origin), {
				method,
				headers: incoming.headers as Record<string, string>,
				...(method === "GET"
					? {}
					: { body: Buffer.concat(chunks).toString("utf8") }),
			}),
		);
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(Buffer.from(await response.arrayBuffer()));
	} catch (error) {
		failures.push(error);
		outgoing.destroy();
	}
});
const closers: (() => Promise<unknown>)[] = [];
const folders = new Set<string>();
function env(secret = token) {
	return { DITERO_URL: origin, DITERO_TOKEN: secret };
}
async function cli(
	command: string,
	body?: unknown,
	id?: string,
	key?: string,
	secret = token,
) {
	let stdout = "",
		stderr = "";
	const exit = await runCli(
		[
			command,
			"--json",
			"--allow-loopback-http",
			...(id ? ["--folder", id] : []),
			...(key ? ["--request-id", key] : []),
		],
		env(secret),
		{
			stdout: (text) => {
				stdout += text;
			},
			stderr: (text) => {
				stderr += text;
			},
		},
		fetch,
		async () => new TextEncoder().encode(JSON.stringify(body)),
	);
	return {
		exit,
		stdout,
		stderr,
		json: stdout ? (JSON.parse(stdout) as { data: unknown }) : { data: null },
	};
}
async function sdk(secret = token) {
	const client = new Client(
		{ name: "folder-fixture", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const [ct, st] = InMemoryTransport.createLinkedPair();
	const handle = serveStdio(
		() =>
			createDiteroMcp(mcpConfiguration(env(secret), ["--allow-loopback-http"])),
		{ transport: st },
	);
	closers.push(
		() => handle.close(),
		() => client.close(),
	);
	await client.connect(ct);
	return client;
}
async function observe(id: string) {
	const result = await cli("observe-folder", undefined, id);
	expect(result.exit).toBe(0);
	return apiFolderObservationSchema.parse(result.json.data);
}
async function create(name: string, secret = token) {
	const result = await cli(
		"create-folder",
		{ workspaceId: workspace, name },
		undefined,
		randomUUID(),
		secret,
	);
	expect(result.exit).toBe(0);
	const id: string = apiFolderCreateAckSchema.parse(result.json.data).snapshot
		.id;
	folders.add(id);
	return id;
}
async function countReceipts() {
	return (
		await admin.query(
			"select count(*)::int n from public_api_request where user_id=any($1::text[])",
			[[alice, bob, outsider]],
		)
	).rows[0].n;
}
beforeAll(async () => {
	expect(
		(await admin.query("select current_database() as name")).rows[0].name,
	).toBe(expectedDatabase);
	expect(
		(
			await admin.query(
				"select count(*)::int n from drizzle.__drizzle_migrations",
			)
		).rows[0].n,
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
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Existing','a0')",
		[list, workspace, alice],
	);
	token = (
		await createPersonalAccessToken(runtime, alice, {
			name: prefix,
			access: "write",
		})
	).token;
	const pat = await createPersonalAccessToken(runtime, bob, {
		name: prefix,
		access: "write",
	});
	bobToken = pat.token;
	bobTokenId = pat.id;
	readToken = (await createPersonalAccessToken(runtime, bob, { name: prefix }))
		.token;
	await new Promise<void>((resolve, reject) => {
		api.once("error", reject);
		api.listen(0, "127.0.0.1", resolve);
	});
	listening = true;
	const address = api.address();
	if (!address || typeof address === "string")
		throw new Error("Missing owned listener");
	origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
	const errors: unknown[] = [...failures];
	async function attempt(fn: () => Promise<unknown>) {
		try {
			await fn();
		} catch (error) {
			errors.push(error);
		}
	}
	for (const close of closers.reverse()) await attempt(close);
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
			"delete from list where id=$1 and workspace_id=$2 and owner_id=$3",
			[list, workspace, alice],
		],
		[
			"delete from folder where id=any($1::text[]) and workspace_id=any($2::text[])",
			[[...folders], [workspace, hidden]],
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
			"delete from workspace where id=any($1::text[]) and owner_id=any($2::text[])",
			[
				[workspace, hidden],
				[alice, outsider],
			],
		],
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
			admin.query(`revoke usage on schema public from "${role}"`),
		);
		await attempt(() => admin.query(`drop role "${role}"`));
	}
	await attempt(() => admin.end());
	if (errors.length)
		throw new AggregateError(errors, "Owned folder fixture cleanup failed", {
			cause: errors[0],
		});
});
test("CLI and MCP create, observe, rename, delete and replay original snapshots without touching replacements", async () => {
	const id = await create("Projects"),
		client = await sdk();
	const observed = await observe(id);
	const update = {
			workspaceId: workspace,
			expectedState: observed.stateToken,
			patch: { name: "Renamed" },
		},
		updateKey = randomUUID();
	const changed = await client.callTool({
		name: "update_folder",
		arguments: { folderId: id, requestId: updateKey, folder: update },
	});
	expect(changed.isError).not.toBe(true);
	expect((await observe(id)).snapshot.name).toBe("Renamed");
	const body = {
			workspaceId: workspace,
			expectedState: (await observe(id)).stateToken,
		},
		key = randomUUID();
	const removed = await cli("delete-folder", body, id, key);
	expect(removed.exit).toBe(0);
	await admin.query(
		"insert into folder(id,workspace_id,name,sort_key) values($1,$2,'Replacement','a0')",
		[id, hidden],
	);
	const replay = await cli("delete-folder", body, id, key);
	expect(replay.exit).toBe(0);
	expect(replay.json).toEqual(removed.json);
	const updateReplay = await client.callTool({
		name: "update_folder",
		arguments: { folderId: id, requestId: updateKey, folder: update },
	});
	expect(updateReplay.structuredContent).toEqual(changed.structuredContent);
	expect(
		(
			await admin.query("select name,workspace_id from folder where id=$1", [
				id,
			])
		).rows[0],
	).toEqual({ name: "Replacement", workspace_id: hidden });
});
test("stale token and nonempty delete refuse with positive unchanged list and receipt controls", async () => {
	const id = await create("Guarded"),
		old = await observe(id);
	await admin.query(
		"update folder set name='Changed' where id=$1 and workspace_id=$2",
		[id, workspace],
	);
	const before = await countReceipts();
	expect(
		(
			await cli(
				"delete-folder",
				{ workspaceId: workspace, expectedState: old.stateToken },
				id,
				randomUUID(),
			)
		).exit,
	).toBe(10);
	await admin.query(
		"update list set folder_id=$1 where id=$2 and workspace_id=$3",
		[id, list, workspace],
	);
	const current = await observe(id);
	const client = await sdk();
	expect(
		(
			await client.callTool({
				name: "delete_folder",
				arguments: {
					folderId: id,
					requestId: randomUUID(),
					folder: { workspaceId: workspace, expectedState: current.stateToken },
				},
			})
		).isError,
	).toBe(true);
	expect(await countReceipts()).toBe(before);
	expect(
		(await admin.query("select folder_id from list where id=$1", [list]))
			.rows[0].folder_id,
	).toBe(id);
	expect(
		(await admin.query("select id from folder where id=$1", [id])).rowCount,
	).toBe(1);
	await admin.query(
		"update list set folder_id=null where id=$1 and workspace_id=$2",
		[list, workspace],
	);
});
test("shared account request UUID conflicts across operations through both clients", async () => {
	const body = { workspaceId: workspace, name: "Collision" },
		key = randomUUID();
	const created = await cli("create-folder", body, undefined, key);
	expect(created.exit).toBe(0);
	const id: string = apiFolderCreateAckSchema.parse(created.json.data).snapshot
		.id;
	folders.add(id);
	const observed = await observe(id),
		before = await countReceipts();
	const client = await sdk();
	expect(
		(
			await client.callTool({
				name: "delete_folder",
				arguments: {
					folderId: id,
					requestId: key,
					folder: {
						workspaceId: workspace,
						expectedState: observed.stateToken,
					},
				},
			})
		).isError,
	).toBe(true);
	expect(
		(
			await cli(
				"create-list",
				{ workspaceId: workspace, title: "Collision", kind: "tasks" },
				undefined,
				key,
			)
		).exit,
	).toBe(10);
	expect(await countReceipts()).toBe(before);
	expect(
		(await admin.query("select id from folder where id=$1", [id])).rowCount,
	).toBe(1);
});
test("read/viewer, removed membership and revoked PAT authority govern writes and immutable replay", async () => {
	const id = await create("Authority", bobToken),
		observation = await observe(id);
	const body = {
			workspaceId: workspace,
			expectedState: observation.stateToken,
			patch: { name: "Member" },
		},
		key = randomUUID();
	expect((await cli("update-folder", body, id, key, bobToken)).exit).toBe(0);
	expect(
		(await cli("observe-folder", undefined, id, undefined, readToken)).exit,
	).toBe(0);
	expect(
		(await cli("update-folder", body, id, randomUUID(), readToken)).exit,
	).toBe(4);
	await admin.query(
		"update membership set role='viewer' where id=$1 and user_id=$2 and workspace_id=$3",
		[`${prefix}_member`, bob, workspace],
	);
	const viewer = await sdk(bobToken);
	expect(
		(
			await viewer.callTool({
				name: "get_folder_observation",
				arguments: { folderId: id },
			})
		).isError,
	).not.toBe(true);
	expect(
		(
			await viewer.callTool({
				name: "update_folder",
				arguments: { folderId: id, requestId: key, folder: body },
			})
		).isError,
	).toBe(true);
	await admin.query(
		"delete from membership where id=$1 and user_id=$2 and workspace_id=$3",
		[`${prefix}_member`, bob, workspace],
	);
	expect((await cli("update-folder", body, id, key, bobToken)).exit).not.toBe(
		0,
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'member')",
		[`${prefix}_member`, bob, workspace],
	);
	await admin.query(
		"update personal_access_token set revoked_at=now() where id=$1 and user_id=$2",
		[bobTokenId, bob],
	);
	expect((await cli("update-folder", body, id, key, bobToken)).exit).toBe(3);
	expect(
		(await admin.query("select name from folder where id=$1", [id])).rows[0]
			.name,
	).toBe("Member");
});
