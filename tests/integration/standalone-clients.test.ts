import { execFile, execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
import release from "../../release.json";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";
import {
	cleanupContainers,
	containerCommand,
	extractClients,
} from "../clients/packaging.ts";

let packaged: Awaited<ReturnType<typeof extractClients>>;
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: databaseURL });
const role = `standalone_${randomUUID().replaceAll("-", "")}`;
const runtimePassword = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = runtimePassword;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
});
const app = publicApiRoutes(runtime, async () => true);
const wires: { path: string; key: string | undefined; body: string }[] = [];
let drop = false;
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
		if (drop && incoming.url?.endsWith("/complete")) {
			drop = false;
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
	packaged = await extractClients();
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
}, 120_000);
beforeEach(async () => {
	actor = randomUUID();
	workspace = randomUUID();
	list = randomUUID();
	task = randomUUID();
	wires.length = 0;
	drop = false;
	await admin.query(
		'insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)',
		[actor, "Agent", `${actor}@completion.test`],
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
	try {
		for (const client of clients.splice(0)) await client.close();
	} finally {
		cleanupContainers(packaged.extracted);
	}
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
	await packaged?.close();
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
	body: unknown,
	key = randomUUID(),
	secret = token,
	operation = "complete-task",
) {
	const child = spawn(
		"docker",
		[
			...containerCommand(packaged.extracted, "ditero"),
			operation,
			...(operation === "complete-task" ? ["--task", task] : []),
			"--request-id",
			key,
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
	let originalFailure: unknown;
	const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
	try {
		child.stdin.end(JSON.stringify(body));
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		return { code, stdout, stderr };
	} catch (error) {
		originalFailure = error;
		throw error;
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await new Promise<void>((resolve) =>
				child.once("close", () => resolve()),
			);
		}
		cleanupContainers(packaged.extracted, originalFailure);
	}
}
async function mcp(secret = token) {
	const transport = new StdioClientTransport({
		command: "docker",
		args: [
			...containerCommand(packaged.extracted, "ditero-mcp"),
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
const once = { history: 1, karma: 1, receipts: 1 };
test("packaged no-Bun CLI completes undated task and replays without duplicate effects", async () => {
	const body = { listId: list, expectedDueAt: null },
		key = randomUUID();
	const first = await cli(body, key);
	expect(first.code).toBe(0);
	expect(JSON.parse(first.stdout)).toMatchObject({
		data: { id: task, done: true },
	});
	expect((await cli(body, key)).code).toBe(0);
	expect(await counts()).toEqual(once);
	expect(wires).toHaveLength(2);
	expect(
		wires.every(
			(w) =>
				w.path.endsWith("/complete") &&
				w.key === key &&
				w.body === JSON.stringify(body),
		),
	).toBe(true);
}, 30_000);
test("packaged no-Bun CLI preserves committed recurring occurrence across uncertain retry and stale refusal", async () => {
	const due = "2026-10-04T12:00:00.000Z";
	await admin.query(
		"update task set due_at=$1,rrule='FREQ=DAILY' where id=$2",
		[due, task],
	);
	const body = { listId: list, expectedDueAt: due },
		key = randomUUID();
	drop = true;
	const lost = await cli(body, key);
	expect(lost.code).toBe(7);
	expect(JSON.parse(lost.stderr)).toMatchObject({
		error: { code: "network_error" },
	});
	expect(wires).toHaveLength(1);
	expect(await counts()).toEqual(once);
	const advanced = (
		await admin.query("select due_at from task where id=$1", [task])
	).rows[0].due_at.toISOString();
	expect(advanced).not.toBe(due);
	expect((await cli(body, key)).code).toBe(0);
	expect((await cli(body)).code).toBe(10);
	expect(await counts()).toEqual(once);
	expect(
		(
			await admin.query("select due_at from task where id=$1", [task])
		).rows[0].due_at.toISOString(),
	).toBe(advanced);
	expect(wires.map((w) => w.body)).toEqual([
		JSON.stringify(body),
		JSON.stringify(body),
		JSON.stringify(body),
	]);
}, 30_000);
test("packaged no-Bun CLI refuses read PAT, revocation, and deleted receipt target", async () => {
	const body = { listId: list, expectedDueAt: null };
	const read = await createPersonalAccessToken(runtime, actor, {
		name: "read",
		access: "read",
	});
	expect((await cli(body, randomUUID(), read.token)).code).toBe(4);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
	const key = randomUUID();
	expect((await cli(body, key)).code).toBe(0);
	await admin.query("delete from task where id=$1", [task]);
	expect((await cli(body, key)).code).toBe(11);
	await revokePersonalAccessToken(runtime, actor, tokenId);
	expect((await cli(body, key)).code).toBe(3);
	expect(wires).toHaveLength(4);
}, 30_000);
test("packaged no-Bun MCP stdio uses inspected due, commits once after lost response, and refuses fresh stale key", async () => {
	const due = "2026-10-04T12:00:00.000Z";
	await admin.query(
		"update task set due_at=$1,rrule='FREQ=DAILY' where id=$2",
		[due, task],
	);
	const client = await mcp();
	const observed = await client.callTool({
		name: "list_tasks",
		arguments: { listId: list },
	});
	expect(observed.structuredContent).toMatchObject({
		data: [{ id: task, dueAt: due }],
	});
	wires.length = 0;
	const args = {
		taskId: task,
		requestId: randomUUID(),
		completion: { listId: list, expectedDueAt: due },
	};
	drop = true;
	expect(
		(await client.callTool({ name: "complete_task", arguments: args }))
			.structuredContent,
	).toMatchObject({ error: { code: "network_error" } });
	expect(wires).toHaveLength(1);
	expect(await counts()).toEqual(once);
	const retry = await client.callTool({
		name: "complete_task",
		arguments: args,
	});
	expect(retry.isError).not.toBe(true);
	expect(retry.structuredContent).toMatchObject({
		data: { id: task, done: false },
	});
	expect(
		(
			await client.callTool({
				name: "complete_task",
				arguments: { ...args, requestId: randomUUID() },
			})
		).structuredContent,
	).toMatchObject({ error: { status: 409 } });
	expect(await counts()).toEqual(once);
	expect(wires).toHaveLength(3);
	expect(wires[0]).toEqual(wires[1]);
}, 30_000);
test("packaged no-Bun MCP stdio rejects strict inputs before HTTP and rechecks revoked authority", async () => {
	const client = await mcp();
	const args = {
		taskId: task,
		requestId: randomUUID(),
		completion: { listId: list, expectedDueAt: null },
	};
	let refused = false;
	try {
		refused =
			(
				await client.callTool({
					name: "complete_task",
					arguments: { ...args, completion: { listId: list } },
				})
			).isError === true;
	} catch {
		refused = true;
	}
	expect(refused).toBe(true);
	expect(wires).toHaveLength(0);
	await revokePersonalAccessToken(runtime, actor, tokenId);
	expect(
		(await client.callTool({ name: "complete_task", arguments: args }))
			.structuredContent,
	).toMatchObject({ error: { status: 401 } });
	expect(wires).toHaveLength(1);
	expect(await counts()).toEqual({ history: 0, karma: 0, receipts: 0 });
}, 30_000);

test("archive identity and hostile local config refusal in a no-Bun/no-Node container", () => {
	const script = `! command -v bun && ! command -v node && for binary in ditero ditero-mcp ditero-tui; do /clients/bin/$binary --version || exit; done; set +e; /clients/bin/ditero profile --json; status=$?; set -e; test "$status" = 2`;
	const result = execFileSync(
		"docker",
		[
			...containerCommand(packaged.extracted, "ditero").slice(0, -1),
			"bash",
			"-euc",
			script,
		],
		{
			env: { PATH: process.env.PATH },
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	expect(result).toContain(`ditero ${release.version}`);
	expect(result).toContain(`ditero-mcp ${release.version}`);
	expect(result).toContain(`ditero-tui ${release.version}`);
	expect(result).not.toContain("HOSTILE_PRELOAD");
});

test("an interrupted Docker client cannot leave its named fixture behind", async () => {
	const args = [
		...containerCommand(packaged.extracted, "ditero").slice(0, -1),
		"bash",
		"-c",
		"trap '' HUP INT TERM; echo FIXTURE_RUNNING; sleep 60",
	];
	const name = args[args.indexOf("--name") + 1];
	const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Timeout control did not start")),
				5000,
			);
			child.stdout.once("data", () => {
				clearTimeout(timer);
				resolve();
			});
			child.once("error", reject);
		});
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
		expect(
			JSON.parse(
				execFileSync("docker", ["inspect", name], { encoding: "utf8" }),
			)[0].State.Running,
		).toBe(true);
	} finally {
		cleanupContainers(packaged.extracted);
	}
	expect(() =>
		execFileSync("docker", ["inspect", name], { stdio: "pipe" }),
	).toThrow();
}, 10000);

const execute = promisify(execFile);
test.each([
	"create",
	"retry",
	"uncertain",
	"revoked",
	"read",
	"arabic",
	"notty",
])("packaged no-Bun terminal/API journey: %s", async (mode) => {
	const { stdout } = await execute(
		"bun",
		[fileURLToPath(new URL("../tui/api-pty.ts", import.meta.url)), mode],
		{
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				NODE_ENV: "test",
				DATABASE_URL: databaseURL,
				TUI_TEST_COMMAND: JSON.stringify([
					"docker",
					...containerCommand(
						packaged.extracted,
						"ditero-tui",
						mode !== "notty",
					),
					...(mode === "notty" ? ["--allow-loopback-http"] : []),
				]),
				TUI_TEST_CWD: packaged.extracted,
			},
			timeout: 20000,
			maxBuffer: 1024 * 1024,
		},
	);
	expect(JSON.parse(stdout)).toMatchObject({ mode, passed: true });
}, 25000);

test("packaged CLI and MCP plan/create/replay use real API and one explicit receipt", async () => {
	const body = { listId: list, title: "Packaged CLI creation" };
	const key = randomUUID();
	const created = await cli(body, key, token, "create-task");
	expect(created.code).toBe(0);
	const taskId = JSON.parse(created.stdout).data.id;
	expect((await cli(body, key, token, "create-task")).code).toBe(0);
	expect(wires).toHaveLength(2);
	expect(wires[0]).toEqual(wires[1]);
	expect(
		(
			await admin.query("select count(*)::int count from task where id=$1", [
				taskId,
			])
		).rows[0].count,
	).toBe(1);
	const client = await mcp();
	expect(client.getServerVersion()).toMatchObject({
		name: "ditero",
		version: release.version,
	});
	const plan = await client.callTool({
		name: "plan_task",
		arguments: {
			title: "Packaged MCP creation",
			target: { kind: "list", selector: { id: list } },
		},
	});
	expect(plan.isError).not.toBe(true);
	const proposal = (plan.structuredContent as { task: unknown }).task;
	const args = { requestId: randomUUID(), task: proposal };
	const first = await client.callTool({ name: "create_task", arguments: args });
	expect(first.isError).not.toBe(true);
	expect(
		(await client.callTool({ name: "create_task", arguments: args }))
			.structuredContent,
	).toEqual(first.structuredContent);
	expect(
		(
			await admin.query(
				"select count(*)::int count from public_api_request where user_id=$1",
				[actor],
			)
		).rows[0].count,
	).toBe(2);
}, 30000);

test("a timed-out PTY fixture preserves its failure and retires the exact container", async () => {
	const args = [
		...containerCommand(packaged.extracted, "ditero").slice(0, -1),
		"bash",
		"-c",
		"trap '' HUP INT TERM; echo FIXTURE_RUNNING; sleep 60",
	];
	args.splice(args.indexOf("-i"), 1, "-it");
	const name = args[args.indexOf("--name") + 1];
	let original: unknown;
	try {
		await execute(
			"bun",
			[fileURLToPath(new URL("../tui/api-pty.ts", import.meta.url)), "create"],
			{
				env: {
					PATH: process.env.PATH,
					HOME: process.env.HOME,
					NODE_ENV: "test",
					DATABASE_URL: databaseURL,
					TUI_TEST_COMMAND: JSON.stringify(["docker", ...args]),
					TUI_TEST_CWD: packaged.extracted,
				},
				timeout: 20000,
				maxBuffer: 1024 * 1024,
			},
		);
	} catch (error) {
		original = error;
	}
	try {
		expect(original).toBeDefined();
		expect((original as { stderr: string }).stderr).toContain(
			"Terminal startup did not finish",
		);
		expect(
			JSON.parse(
				execFileSync("docker", ["inspect", name], { encoding: "utf8" }),
			)[0].State.Running,
		).toBe(true);
	} finally {
		cleanupContainers(packaged.extracted);
	}
	expect(() =>
		execFileSync("docker", ["inspect", name], { stdio: "pipe" }),
	).toThrow();
}, 25000);
