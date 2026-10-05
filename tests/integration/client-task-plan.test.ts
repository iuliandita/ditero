import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import {
	Client,
	ProtocolError,
	ProtocolErrorCode,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test as vitestTest,
} from "vitest";
import journal from "../../drizzle/meta/_journal.json";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";

type Choice = { id: string; name: string };
type Failure = {
	code: string;
	status: number | null;
	message: string;
	choices?: Choice[];
};
type Plan = {
	version: 1;
	task: {
		listId: string;
		title: string;
		dueAt: string | null;
		dueAllDay: boolean;
		priority: number;
		assigneeIds: string[];
		labelIds: string[];
	};
	target: { kind: "list" | "dashboard"; id: string };
	timezone: string;
	resolvedAt: string;
};

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_CLIENT_TASK_PLAN_TEST_DATABASE ?? "ditero_e2e";
if (
	process.env.NODE_ENV !== "test" ||
	!databaseURL ||
	new URL(databaseURL).pathname !== `/${expectedDatabase}`
)
	throw new Error("Explicit test database and NODE_ENV=test are required");
const poolLimits = {
	connectionTimeoutMillis: 5_000,
	query_timeout: 15_000,
	statement_timeout: 15_000,
};
const MCP_TIMEOUT = 20_000;
const admin = new Pool({ connectionString: databaseURL, ...poolLimits });
const role = `client_plan_${randomUUID().replaceAll("-", "")}`;
const runtimePassword = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = runtimePassword;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
	...poolLimits,
});
// Lifecycle state: allocation flags are set before the statement that could
// leave state behind, and IDs are never cleared after a failed cleanup.
let roleCreated = false;
let roleOid: string | null = null;
let schemaGranted = false;
let tablesGranted = false;
let listening = false;
let ready = false;
let cleanupFailed = false;
const causes: unknown[] = [];
async function preserveCause(body: () => Promise<void>) {
	try {
		await body();
	} catch (error) {
		causes.push(error);
		throw error;
	}
}
const test = (name: string, body: () => Promise<void>, timeout: number) =>
	vitestTest(name, () => preserveCause(body), timeout);
// Raw secrets never reach an assertion message: compare, then report a label.
const leaks = (text: string, ...secrets: string[]) =>
	secrets.some((secret) => text.includes(secret));
const noLeak = (text: string, ...secrets: string[]) =>
	expect({ leaked: leaks(text, ...secrets) }).toEqual({ leaked: false });
const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
async function bounded<T>(work: Promise<T>, ms: number, label: string) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(label)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
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
	try {
		await bounded(closed, 3000, "Owned CLI did not close after SIGKILL");
	} finally {
		clearTimeout(force);
		if (child.exitCode !== null || child.signalCode !== null)
			children.delete(child);
	}
}
type McpSession = {
	client: Client;
	transport: StdioClientTransport;
	pid: number | null;
	stderr: () => string;
	secret: string;
};
const sessions: McpSession[] = [];
const unprovenPids: number[] = [];
function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
async function absent(pid: number, ms: number) {
	const end = Date.now() + ms;
	while (alive(pid)) {
		if (Date.now() >= end) return false;
		await sleep(50);
	}
	return true;
}
async function closeSession(session: McpSession) {
	const errors: unknown[] = [];
	try {
		await bounded(
			session.client.close(),
			10_000,
			"MCP close deadline exceeded",
		);
	} catch (error) {
		errors.push(error);
	}
	if (session.pid !== null && !(await absent(session.pid, 2000))) {
		try {
			process.kill(session.pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") errors.push(error);
		}
		if (!(await absent(session.pid, 3000))) {
			unprovenPids.push(session.pid);
			errors.push(new Error("Owned MCP process still present after SIGKILL"));
		}
	}
	if (errors.length)
		throw new AggregateError(errors, "MCP session close failed");
}
const app = publicApiRoutes(runtime, async () => true);
const wires: { path: string; method: string | undefined; key?: string }[] = [];
// Test seam: rewrites only the wire copy of the profile's server clock.
let pinned: string | null = null;
let pinHits = 0;
let origin: string;
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
		});
		const response = await app.handle(
			new Request(`${origin}${incoming.url}`, {
				method: incoming.method,
				headers,
				...(body ? { body } : {}),
			}),
		);
		let bytes = Buffer.from(await response.arrayBuffer());
		const outHeaders = Object.fromEntries(response.headers);
		if (
			pinned !== null &&
			response.status === 200 &&
			new URL(incoming.url ?? "", origin).pathname === "/api/v1/me"
		) {
			const parsed = JSON.parse(bytes.toString());
			parsed.data.serverTime = pinned;
			bytes = Buffer.from(JSON.stringify(parsed));
			delete outHeaders["content-length"];
			pinHits++;
		}
		outgoing.writeHead(response.status, outHeaders);
		outgoing.end(bytes);
	} catch {
		outgoing.writeHead(500);
		outgoing.end();
	}
});

// Exact IDs created by the current test, tracked before each insert so a
// failed fixture still cleans up what it created.
const users: string[] = [];
const workspaces: string[] = [];
const lists: string[] = [];
const labels: string[] = [];
const dashboards: string[] = [];
let actor: string;
let alexA: string;
let alexB: string;
let stranger: string;
let casey: string;
let personalWorkspace: string;
let shared: string;
let viewerWorkspace: string;
let decoyWorkspace: string;
let personalTasks: string;
let sharedTasks: string;
let sharedTeam: string;
let viewerList: string;
let alexLabelShared: string;
let alexLabelPersonal: string;
let errandLabel: string;
let todayDashboard: string;
let bothPersonal: string;
let bothShared: string;
let multiDashboard: string;
let mineDashboard: string;
let token: string;
let tokenId: string;
let todayPanels: unknown;

function track(into: string[]) {
	const id = randomUUID();
	into.push(id);
	return id;
}
function listFilter(...ids: string[]) {
	return {
		op: "and",
		conditions: [
			ids.length === 1
				? { field: "list", operator: "eq", value: ids[0] }
				: { field: "list", operator: "in", value: ids },
		],
	};
}
function panels(filter: unknown, workspaceScope: { mode: "one"; id: string }) {
	return [
		{
			id: "p1",
			type: "tasks",
			size: "full",
			source: {
				kind: "inline",
				filter,
				sort: { field: "due", dir: "asc" },
				workspaceScope,
			},
		},
	];
}
async function addUser(name: string) {
	const id = track(users);
	await admin.query(
		'insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)',
		[id, name, `${id}@plan.test`],
	);
	return id;
}
async function addWorkspace(
	kind: "personal" | "shared",
	owner: string,
	members: [string, string][] = [],
) {
	const id = track(workspaces);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ($1,$2,$3,$4)",
		[id, `Plan ${kind}`, owner, kind],
	);
	await admin.query(
		"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,'owner')",
		[randomUUID(), owner, id],
	);
	for (const [user, memberRole] of members)
		await admin.query(
			"insert into membership (id,user_id,workspace_id,role) values ($1,$2,$3,$4)",
			[randomUUID(), user, id, memberRole],
		);
	return id;
}
async function addList(workspace: string, owner: string, title: string) {
	const id = track(lists);
	await admin.query(
		"insert into list (id,workspace_id,owner_id,title,sort_key) values ($1,$2,$3,$4,'a0')",
		[id, workspace, owner, title],
	);
	return id;
}
async function addLabel(workspace: string, name: string) {
	const id = track(labels);
	await admin.query(
		"insert into label (id,workspace_id,name,color) values ($1,$2,$3,'gray')",
		[id, workspace, name],
	);
	return id;
}
async function addDashboard(
	owner: string,
	scope: "personal" | "workspace",
	workspace: string | null,
	name: string,
	body: unknown,
) {
	const id = track(dashboards);
	await admin.query(
		"insert into dashboard (id,owner_id,scope,workspace_id,name,sort_key,panels) values ($1,$2,$3,$4,$5,'a0',$6::jsonb)",
		[id, owner, scope, workspace, name, JSON.stringify(body)],
	);
	return id;
}
async function setZone(timezone: string, chosen = true) {
	await admin.query(
		"update user_pref set timezone=$2,timezone_chosen=$3 where id=$1",
		[actor, timezone, chosen],
	);
}

beforeAll(async () =>
	preserveCause(async () => {
		// Target guard, before anything is allocated.
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
		expect(
			(
				await admin.query(
					"select (rolsuper or rolcreaterole) as can_create_role,(rolsuper or rolbypassrls) as can_bypass_rls,(select count(*)::int from pg_roles where rolname=$1) as existing from pg_roles where rolname=current_user",
					[role],
				)
			).rows[0],
		).toEqual({ can_create_role: true, can_bypass_rls: true, existing: 0 });
		const statement = await admin.query<{ statement: string }>(
			"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) as statement",
			[role, runtimePassword],
		);
		await admin.query(statement.rows[0].statement);
		roleCreated = true;
		roleOid = (
			await admin.query<{ oid: string }>(
				"select oid::text as oid from pg_roles where rolname=$1",
				[role],
			)
		).rows[0].oid;
		schemaGranted = true;
		await admin.query(`grant usage on schema public to "${role}"`);
		tablesGranted = true;
		await admin.query(
			`grant select,insert,update,delete on all tables in schema public to "${role}"`,
		);
		expect(
			(
				await runtime.query(
					"select r.oid::text as oid,current_user,session_user,rolsuper,rolbypassrls,rolinherit,rolcanlogin,rolcreatedb,rolcreaterole,(select count(*)::int from pg_auth_members where member=r.oid) as memberships,(select count(*)::int from pg_class where relowner=r.oid) as owned from pg_roles r where rolname=current_user",
				)
			).rows[0],
		).toEqual({
			oid: roleOid,
			current_user: role,
			session_user: role,
			rolsuper: false,
			rolbypassrls: false,
			rolinherit: false,
			rolcanlogin: true,
			rolcreatedb: false,
			rolcreaterole: false,
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
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
		listening = true;
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing fixture listener");
		origin = `http://127.0.0.1:${address.port}`;
		ready = true;
	}),
);
beforeEach(async () => preserveCause(setupFixture));
async function setupFixture() {
	if (!ready || cleanupFailed)
		throw new Error("Harness is not ready for a fixture");
	wires.length = 0;
	pinned = null;
	pinHits = 0;
	actor = await addUser("Planner");
	alexA = await addUser("Alex");
	alexB = await addUser("Alex");
	stranger = await addUser("Alex");
	casey = await addUser("Casey");
	await admin.query(
		"insert into user_pref (id,timezone,timezone_chosen) values ($1,'Pacific/Kiritimati',true)",
		[actor],
	);
	personalWorkspace = await addWorkspace("personal", actor);
	shared = await addWorkspace("shared", actor, [
		[alexA, "member"],
		[alexB, "member"],
	]);
	viewerWorkspace = await addWorkspace("shared", casey, [[actor, "viewer"]]);
	decoyWorkspace = await addWorkspace("shared", stranger);
	personalTasks = await addList(personalWorkspace, actor, "Tasks");
	sharedTasks = await addList(shared, actor, "Tasks");
	sharedTeam = await addList(shared, actor, "Team");
	viewerList = await addList(viewerWorkspace, casey, "Viewer list");
	await addList(decoyWorkspace, stranger, "Tasks");
	alexLabelShared = await addLabel(shared, "Alex");
	alexLabelPersonal = await addLabel(personalWorkspace, "Alex");
	errandLabel = await addLabel(shared, "errand");
	// Private presentation over shared data: personal scope, shared backing list.
	todayPanels = panels(listFilter(sharedTasks), { mode: "one", id: shared });
	todayDashboard = await addDashboard(
		actor,
		"personal",
		null,
		"Today",
		todayPanels,
	);
	await addDashboard(stranger, "personal", null, "Today", todayPanels);
	multiDashboard = await addDashboard(
		actor,
		"personal",
		null,
		"Multi",
		panels(listFilter(sharedTasks, sharedTeam), { mode: "one", id: shared }),
	);
	mineDashboard = await addDashboard(
		actor,
		"personal",
		null,
		"Mine",
		panels(listFilter(personalTasks), { mode: "one", id: personalWorkspace }),
	);
	await addDashboard(
		actor,
		"personal",
		null,
		"Urgent",
		panels(
			{
				op: "and",
				conditions: [
					{ field: "list", operator: "eq", value: sharedTasks },
					{ field: "priority", operator: "gte", value: 3 },
				],
			},
			{ mode: "one", id: shared },
		),
	);
	for (let copy = 0; copy < 2; copy++)
		await addDashboard(actor, "personal", null, "Dupe", todayPanels);
	bothPersonal = await addDashboard(
		actor,
		"personal",
		null,
		"Both",
		panels(listFilter(personalTasks), { mode: "one", id: personalWorkspace }),
	);
	bothShared = await addDashboard(
		alexA,
		"workspace",
		shared,
		"Both",
		todayPanels,
	);
	await addDashboard(alexA, "workspace", shared, "Shared only", todayPanels);
	const pat = await createPersonalAccessToken(runtime, actor, {
		name: "writer",
		access: "write",
	});
	token = pat.token;
	tokenId = pat.id;
}
async function residue() {
	return (
		await admin.query(
			`select (select count(*)::int from "user" where id=any($1::text[])) users,
			(select count(*)::int from workspace where id=any($2::text[])) workspaces,
			(select count(*)::int from list where id=any($3::text[])) lists,
			(select count(*)::int from label where id=any($4::text[])) labels,
			(select count(*)::int from dashboard where id=any($5::text[])) dashboards,
			(select count(*)::int from task where list_id=any($3::text[])) tasks,
			(select count(*)::int from membership where workspace_id=any($2::text[])) memberships,
			(select count(*)::int from public_api_request where user_id=any($1::text[])) receipts,
			(select count(*)::int from invite where workspace_id=any($2::text[])) invites`,
			[users, workspaces, lists, labels, dashboards],
		)
	).rows[0];
}
const noResidue = {
	users: 0,
	workspaces: 0,
	lists: 0,
	labels: 0,
	dashboards: 0,
	tasks: 0,
	memberships: 0,
	receipts: 0,
	invites: 0,
};
afterEach(async () => {
	// A failed cleanup is evidence: no retry, and the tracked IDs stay for afterAll.
	if (cleanupFailed) return;
	const failures: unknown[] = [];
	const step = async (operation: () => Promise<unknown>) => {
		try {
			await operation();
		} catch (error) {
			failures.push(error);
		}
	};
	for (const child of [...children]) await step(() => reap(child));
	for (const session of sessions.splice(0)) {
		await step(() => closeSession(session));
		await step(async () =>
			noLeak(session.stderr(), session.secret, runtimePassword),
		);
	}
	// Processes must be proven closed before any fixture SQL runs.
	if (failures.length === 0) {
		const owned = (sql: string, ids: string[]) =>
			step(() => admin.query(sql, [ids]));
		await owned(
			"delete from public_api_request where user_id=any($1::text[])",
			users,
		);
		await owned("delete from task where list_id=any($1::text[])", lists);
		await owned("delete from dashboard where id=any($1::text[])", dashboards);
		await owned("delete from label where id=any($1::text[])", labels);
		await owned("delete from list where id=any($1::text[])", lists);
		await owned("delete from user_pref where id=any($1::text[])", users);
		await owned(
			"delete from invite where workspace_id=any($1::text[])",
			workspaces,
		);
		await owned(
			"delete from membership where workspace_id=any($1::text[])",
			workspaces,
		);
		await owned("delete from workspace where id=any($1::text[])", workspaces);
		await owned('delete from "user" where id=any($1::text[])', users);
		if (failures.length === 0)
			await step(async () => expect(await residue()).toEqual(noResidue));
	}
	if (failures.length === 0) {
		for (const ids of [users, workspaces, lists, labels, dashboards])
			ids.length = 0;
		return;
	}
	cleanupFailed = true;
	throw new AggregateError([...causes, ...failures], "Fixture cleanup", {
		cause: causes[0] ?? failures[0],
	});
});
afterAll(async () => {
	const failures: unknown[] = [];
	const step = async (operation: () => Promise<unknown>) => {
		try {
			await operation();
		} catch (error) {
			failures.push(error);
		}
	};
	if (listening)
		await step(async () => {
			server.closeAllConnections();
			await bounded(
				new Promise<void>((resolve, reject) =>
					server.close((error) => (error ? reject(error) : resolve())),
				),
				5000,
				"Fixture listener did not close",
			);
		});
	await step(() => bounded(runtime.end(), 5000, "Runtime pool did not close"));
	if (roleCreated)
		await step(async () => {
			// Identity check before touching a role this file did not prove it owns.
			expect(
				(
					await admin.query(
						"select rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls from pg_roles where oid=$1::oid",
						[roleOid],
					)
				).rows,
			).toEqual([
				{
					rolname: role,
					rolcanlogin: true,
					rolsuper: false,
					rolcreatedb: false,
					rolcreaterole: false,
					rolinherit: false,
					rolbypassrls: false,
				},
			]);
			if (tablesGranted)
				await admin.query(
					`revoke select,insert,update,delete on all tables in schema public from "${role}"`,
				);
			if (schemaGranted)
				await admin.query(`revoke usage on schema public from "${role}"`);
			const inventory = (
				await admin.query(
					`select (select count(*)::int from pg_class where relowner=r.oid) owned,
					(select count(*)::int from pg_auth_members where member=r.oid or roleid=r.oid or grantor=r.oid) memberships,
					(select count(*)::int from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=r.oid) shared_dependencies
					from pg_roles r where r.oid=$1::oid`,
					[roleOid],
				)
			).rows[0];
			expect(inventory).toEqual({
				owned: 0,
				memberships: 0,
				shared_dependencies: 0,
			});
			// Plain DROP ROLE refuses while any dependency remains.
			await admin.query(`drop role "${role}"`);
		});
	await step(async () => {
		expect(
			(
				await admin.query(
					"select (select count(*)::int from pg_roles where rolname=$1) roles,(select count(*)::int from pg_stat_activity where usename=$1) sessions",
					[role],
				)
			).rows[0],
		).toEqual({ roles: 0, sessions: 0 });
	});
	await step(async () => expect(await residue()).toEqual(noResidue));
	await step(async () => {
		expect(children.size).toBe(0);
		expect(sessions).toEqual([]);
		expect(unprovenPids.filter(alive)).toEqual([]);
	});
	await step(() => bounded(admin.end(), 5000, "Admin pool did not close"));
	if (failures.length)
		throw new AggregateError([...causes, ...failures], "Harness cleanup", {
			cause: causes[0] ?? failures[0],
		});
});

async function counts() {
	return (
		await admin.query(
			`select (select count(*)::int from task where list_id=any($1::text[])) tasks,
			(select count(*)::int from public_api_request where user_id=$2) receipts,
			(select count(*)::int from membership where workspace_id=any($3::text[])) memberships,
			(select count(*)::int from invite where workspace_id=any($3::text[])) invites`,
			[lists, actor, workspaces],
		)
	).rows[0];
}
async function cli(args: string[], body?: unknown, secret = token) {
	const child = spawn(
		"bun",
		[
			"run",
			fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url)),
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
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	let stdinFailure: unknown;
	child.stdin.on("error", (error: NodeJS.ErrnoException) => {
		if (error.code !== "EPIPE") stdinFailure = error;
	});
	const closed = new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => {
			children.delete(child);
			if (stdinFailure) reject(stdinFailure);
			else resolve(code);
		});
	});
	child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
	let code: number | null;
	try {
		code = await bounded(
			closed,
			18_000,
			"Owned CLI protocol deadline exceeded",
		);
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
	}
	noLeak(stdout + stderr, secret, runtimePassword, runtimeURL.toString());
	return { code, stdout, stderr };
}
function failure(result: { stderr: string }): Failure {
	const line = result.stderr.trim().split("\n").filter(Boolean).pop() ?? "";
	try {
		return JSON.parse(line).error;
	} catch {
		throw new Error("CLI stderr did not end with a JSON error line");
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
	let stderr = "";
	transport.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const client = new Client(
		{ name: "actual-task-plan", version: "1" },
		{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
	);
	const session: McpSession = {
		client,
		transport,
		pid: null,
		stderr: () => stderr,
		secret,
	};
	sessions.push(session);
	const connecting = client.connect(transport, { timeout: MCP_TIMEOUT });
	session.pid = transport.pid;
	try {
		await bounded(connecting, MCP_TIMEOUT, "MCP connect deadline exceeded");
	} finally {
		session.pid ??= transport.pid;
	}
	if (session.pid === null) throw new Error("MCP process id unavailable");
	return client;
}
const callTool = (client: Client, params: Parameters<Client["callTool"]>[0]) =>
	client.callTool(params, { timeout: MCP_TIMEOUT });

let titleSeed = 0;
function intent(over: Record<string, unknown> = {}) {
	return {
		title: `Planned ${++titleSeed}`,
		target: { kind: "dashboard", selector: { name: "Today" } },
		...over,
	};
}
function listTarget(name: string, extra: Record<string, unknown> = {}) {
	return { kind: "list", selector: { name }, ...extra };
}
async function plan(body: unknown, secret = token) {
	return cli(["plan-task"], body, secret);
}
async function planned(body: unknown): Promise<Plan> {
	const result = await plan(body);
	expect(result.code).toBe(0);
	return JSON.parse(result.stdout);
}
const sorted = (values: string[]) => [...values].sort();
const choiceIds = (error: Failure) =>
	sorted((error.choices ?? []).map((c) => c.id));
const writes = () => wires.filter((wire) => wire.method !== "GET");
const PIN = "2026-03-07T23:30:00.000Z";

async function expectRefused(
	body: unknown,
	code: string,
	choices: string[] | null,
) {
	const before = await counts();
	wires.length = 0;
	const result = await plan(body);
	expect(result.code).toBe(2);
	const error = failure(result);
	expect(error.code).toBe(code);
	if (choices !== null) expect(choiceIds(error)).toEqual(sorted(choices));
	expect(writes()).toEqual([]);
	expect(await counts()).toEqual(before);
	return error;
}

test("dashboard plan resolves authorized assignee, label and zoned due date, then one UUID write reads back", async () => {
	pinned = PIN;
	const before = await counts();
	const ambiguous = await expectRefused(
		intent({
			assignees: [{ name: "Alex" }],
			labels: [{ name: "errand" }],
			due: { day: "tomorrow" },
		}),
		"ambiguous-assignee",
		[alexA, alexB],
	);
	expect(ambiguous.choices?.map((c) => c.name)).toEqual(["Alex", "Alex"]);
	const proposal = await planned(
		intent({
			title: "Dashboard planned",
			assignees: [{ id: alexA }],
			labels: [{ name: "errand" }],
			due: { day: "tomorrow" },
		}),
	);
	expect(pinHits).toBeGreaterThan(0);
	expect(proposal).toMatchObject({
		version: 1,
		task: {
			listId: sharedTasks,
			title: "Dashboard planned",
			notes: null,
			dueAt: "2026-03-08T22:00:00.000Z",
			dueAllDay: true,
			priority: 0,
			assigneeIds: [alexA],
			labelIds: [errandLabel],
		},
		target: { kind: "dashboard", id: todayDashboard },
		timezone: "Pacific/Kiritimati",
		resolvedAt: PIN,
	});
	expect(await counts()).toEqual(before);
	expect(writes()).toEqual([]);
	const key = randomUUID();
	const created = await cli(
		["create-task", "--request-id", key],
		proposal.task,
	);
	expect(created.code).toBe(0);
	const task = JSON.parse(created.stdout).data;
	expect(writes()).toEqual([{ path: "/api/v1/tasks", method: "POST", key }]);
	const row = (
		await admin.query(
			"select list_id,due_at,due_all_day,(select array_agg(user_id) from task_assignee where task_id=$1) assignees,(select array_agg(label_id) from task_label where task_id=$1) task_labels from task where id=$1",
			[task.id],
		)
	).rows[0];
	expect(row.list_id).toBe(sharedTasks);
	expect(row.due_at.toISOString()).toBe("2026-03-08T22:00:00.000Z");
	expect(row.due_all_day).toBe(true);
	expect(row.assignees).toEqual([alexA]);
	expect(row.task_labels).toEqual([errandLabel]);
	expect(
		(
			await admin.query("select panels from dashboard where id=$1", [
				todayDashboard,
			])
		).rows[0].panels,
	).toEqual(todayPanels);
	expect(await counts()).toEqual({
		...before,
		tasks: before.tasks + 1,
		receipts: before.receipts + 1,
	});
	const readback = await cli(["tasks", "--list", sharedTasks]);
	expect(readback.code).toBe(0);
	expect(
		JSON.parse(readback.stdout).data.find(
			(item: { id: string }) => item.id === task.id,
		),
	).toMatchObject({
		listId: sharedTasks,
		dueAt: "2026-03-08T22:00:00.000Z",
		dueAllDay: true,
		assigneeIds: [alexA],
		labelIds: [errandLabel],
	});
}, 90_000);

test("assignee Alex and label Alex stay separate, unknown tag keys fail strictly, and non-members create no access or invite", async () => {
	const assigneeOnly = await planned(
		intent({
			target: listTarget("Team"),
			assignees: [{ id: alexA }],
		}),
	);
	expect(assigneeOnly.task).toMatchObject({
		assigneeIds: [alexA],
		labelIds: [],
	});
	const labelOnly = await planned(
		intent({ target: listTarget("Team"), labels: [{ name: "Alex" }] }),
	);
	// The shared label wins over the same-named personal-workspace label.
	expect(labelOnly.task).toMatchObject({
		assigneeIds: [],
		labelIds: [alexLabelShared],
	});
	expect(labelOnly.task.labelIds).not.toContain(alexLabelPersonal);
	for (const unknown of [
		{ tag: [{ name: "Alex" }] },
		{ labels: [{ tag: "Alex" }] },
		{ assignees: [{ name: "Alex", tag: "Alex" }] },
	]) {
		const before = await counts();
		wires.length = 0;
		const result = await plan(
			intent({ target: listTarget("Team"), ...unknown }),
		);
		expect(result.code).toBe(2);
		expect(failure(result).code).toBe("invalid_input");
		expect(wires).toEqual([]);
		expect(await counts()).toEqual(before);
	}
	// Only people sharing the target workspace are authorized choices.
	await expectRefused(
		intent({ target: listTarget("Team"), assignees: [{ name: "Alex" }] }),
		"ambiguous-assignee",
		[alexA, alexB],
	);
	await expectRefused(
		intent({ target: listTarget("Team"), assignees: [{ name: "Casey" }] }),
		"assignee-not-found",
		[],
	);
	await expectRefused(
		intent({ target: listTarget("Team"), assignees: [{ id: casey }] }),
		"assignee-not-found",
		[],
	);
	const client = await mcp();
	const before = await counts();
	const raw = await callTool(client, {
		name: "create_task",
		arguments: {
			requestId: randomUUID(),
			task: {
				listId: sharedTeam,
				title: "Outsider",
				notes: null,
				dueAt: null,
				dueAllDay: false,
				priority: 0,
				assigneeIds: [casey],
				labelIds: [],
			},
		},
	});
	expect(raw.isError).toBe(true);
	// The CLI client maps every HTTP 400 to request_rejected; the MCP catch
	// forwards that CliError unchanged.
	expect(raw.structuredContent).toMatchObject({
		error: { status: 400, code: "request_rejected" },
	});
	expect(await counts()).toEqual(before);
	expect(
		(
			await admin.query(
				"select count(*)::int as count from task_assignee where user_id=$1",
				[casey],
			)
		).rows[0].count,
	).toBe(0);
}, 90_000);

test("ambiguous list, dashboard, backing-list and person names never write and resolve only with explicit IDs", async () => {
	await expectRefused(
		intent({ target: listTarget("Tasks") }),
		"ambiguous-list",
		[personalTasks, sharedTasks],
	);
	await expectRefused(
		intent({ target: { kind: "dashboard", selector: { name: "Dupe" } } }),
		"ambiguous-dashboard",
		(
			await admin.query(
				"select id from dashboard where owner_id=$1 and name='Dupe'",
				[actor],
			)
		).rows.map((row) => row.id),
	);
	await expectRefused(
		intent({ target: { kind: "dashboard", selector: { name: "Multi" } } }),
		"ambiguous-backing-list",
		[sharedTasks, sharedTeam],
	);
	await expectRefused(
		intent({
			target: { kind: "dashboard", selector: { id: multiDashboard } },
			assignees: [{ name: "Alex" }],
		}),
		"ambiguous-backing-list",
		[sharedTasks, sharedTeam],
	);
	const resolved = await planned(
		intent({
			target: {
				kind: "dashboard",
				selector: { id: multiDashboard },
				listId: sharedTeam,
			},
			assignees: [{ id: alexB }],
		}),
	);
	expect(resolved.target).toEqual({ kind: "dashboard", id: multiDashboard });
	expect(resolved.task).toMatchObject({
		listId: sharedTeam,
		assigneeIds: [alexB],
	});
}, 90_000);

test("personal scope, shared lists, dashboard filters and explicit list conflicts resolve without widening authority", async () => {
	const personal = await planned(
		intent({ target: listTarget("Tasks", { personal: true }) }),
	);
	expect(personal.target).toEqual({ kind: "list", id: personalTasks });
	expect(personal.task.listId).toBe(personalTasks);
	await expectRefused(
		intent({ target: listTarget("Team", { personal: true }) }),
		"list-not-found",
		[],
	);
	await expectRefused(
		intent({
			target: listTarget("Tasks", { personal: true, listId: sharedTasks }),
		}),
		"target-conflict",
		null,
	);
	await expectRefused(
		intent({
			target: {
				kind: "list",
				selector: { id: personalTasks },
				listId: sharedTasks,
			},
		}),
		"target-conflict",
		null,
	);
	// personal:true keeps the data scope personal, so the shared-backed
	// presentation cannot supply a backing list.
	await expectRefused(
		intent({
			target: {
				kind: "dashboard",
				selector: { name: "Today" },
				personal: true,
			},
		}),
		"backing-list-not-found",
		[],
	);
	await expectRefused(
		intent({
			target: {
				kind: "dashboard",
				selector: { name: "Shared only" },
				personal: true,
			},
		}),
		"dashboard-not-found",
		[],
	);
	await expectRefused(
		intent({ target: { kind: "dashboard", selector: { name: "Both" } } }),
		"ambiguous-dashboard",
		[bothPersonal, bothShared],
	);
	const mine = await planned(
		intent({
			target: { kind: "dashboard", selector: { name: "Both" }, personal: true },
		}),
	);
	expect(mine.target).toEqual({ kind: "dashboard", id: bothPersonal });
	expect(mine.task.listId).toBe(personalTasks);
	// Alex is a member of the shared workspace only, never of the personal one.
	for (const assignee of [{ name: "Alex" }, { id: alexA }])
		await expectRefused(
			intent({
				target: {
					kind: "dashboard",
					selector: { id: mineDashboard },
					personal: true,
				},
				assignees: [assignee],
			}),
			"assignee-not-found",
			[],
		);
	await expectRefused(
		intent({
			target: { kind: "dashboard", selector: { name: "Urgent" } },
			priority: 0,
		}),
		"dashboard-filter-mismatch",
		null,
	);
	const urgent = await planned(
		intent({
			target: { kind: "dashboard", selector: { name: "Urgent" } },
			priority: 3,
		}),
	);
	expect(urgent.task).toMatchObject({ listId: sharedTasks, priority: 3 });
}, 90_000);

test("account timezone is required for dated tasks, and instants match literals and Postgres across UTC+14, UTC-11 and DST", async () => {
	await setZone("Pacific/Kiritimati", false);
	pinned = PIN;
	await expectRefused(
		intent({ target: listTarget("Team"), due: { day: "tomorrow" } }),
		"timezone-required",
		null,
	);
	const undated = await planned(intent({ target: listTarget("Team") }));
	expect(undated.task).toMatchObject({ dueAt: null, dueAllDay: false });
	const ny = "2026-03-07T17:00:00.000Z";
	const cases = [
		{
			zone: "Pacific/Kiritimati",
			pin: PIN,
			due: { day: "tomorrow" },
			local: "2026-03-09 12:00",
			expected: "2026-03-08T22:00:00.000Z",
			allDay: true,
		},
		{
			zone: "Pacific/Kiritimati",
			pin: PIN,
			due: { day: "today" },
			local: "2026-03-08 12:00",
			expected: "2026-03-07T22:00:00.000Z",
			allDay: true,
		},
		{
			zone: "Pacific/Pago_Pago",
			pin: PIN,
			due: { day: "tomorrow" },
			local: "2026-03-08 12:00",
			expected: "2026-03-08T23:00:00.000Z",
			allDay: true,
		},
		{
			zone: "America/New_York",
			pin: ny,
			due: { day: "tomorrow" },
			local: "2026-03-08 12:00",
			expected: "2026-03-08T16:00:00.000Z",
			allDay: true,
		},
		{
			zone: "America/New_York",
			pin: ny,
			due: { day: "2026-11-01" },
			local: "2026-11-01 12:00",
			expected: "2026-11-01T17:00:00.000Z",
			allDay: true,
		},
		{
			zone: "America/New_York",
			pin: ny,
			due: { day: "2026-03-09", time: "09:30" },
			local: "2026-03-09 09:30",
			expected: "2026-03-09T13:30:00.000Z",
			allDay: false,
		},
	];
	for (const item of cases) {
		await setZone(item.zone);
		pinned = item.pin;
		const oracle = (
			await admin.query(
				"select ($1::timestamp at time zone $2::text) as instant",
				[item.local, item.zone],
			)
		).rows[0].instant as Date;
		expect(oracle.toISOString()).toBe(item.expected);
		const proposal = await planned(
			intent({ target: listTarget("Team"), due: item.due }),
		);
		expect(proposal.task.dueAt).toBe(item.expected);
		expect(proposal.task.dueAllDay).toBe(item.allDay);
		expect(proposal).toMatchObject({
			timezone: item.zone,
			resolvedAt: item.pin,
		});
	}
	// Positive control: without the pin the real profile clock is current.
	pinned = null;
	const hits = pinHits;
	const profile = await fetch(`${origin}/api/v1/me`, {
		headers: { authorization: `Bearer ${token}` },
	});
	expect(profile.status).toBe(200);
	const serverTime = Date.parse((await profile.json()).data.serverTime);
	expect(Math.abs(serverTime - Date.now())).toBeLessThan(60_000);
	expect(pinHits).toBe(hits);
}, 120_000);

test("create UUID replays by body, conflicts on a different body, and reports a deleted original", async () => {
	const proposal = await planned(
		intent({ target: listTarget("Team"), title: "Idempotent plan" }),
	);
	const key = randomUUID();
	const first = await cli(["create-task", "--request-id", key], proposal.task);
	expect(first.code).toBe(0);
	const task = JSON.parse(first.stdout).data;
	const before = await counts();
	const replay = await cli(["create-task", "--request-id", key], proposal.task);
	expect(replay.code).toBe(0);
	expect(JSON.parse(replay.stdout).data.id).toBe(task.id);
	expect(await counts()).toEqual(before);
	const mismatch = await cli(["create-task", "--request-id", key], {
		...proposal.task,
		title: "Different body",
	});
	expect(mismatch.code).toBe(10);
	expect(await counts()).toEqual(before);
	// A new UUID is a new write; bodies are never deduplicated by content.
	const other = await cli(
		["create-task", "--request-id", randomUUID()],
		proposal.task,
	);
	expect(other.code).toBe(0);
	expect(JSON.parse(other.stdout).data.id).not.toBe(task.id);
	expect(await counts()).toEqual({
		...before,
		tasks: before.tasks + 1,
		receipts: before.receipts + 1,
	});
	await admin.query("delete from task where id=$1", [task.id]);
	const deleted = await cli(
		["create-task", "--request-id", key],
		proposal.task,
	);
	expect(deleted.code).toBe(11);
	expect((await counts()).tasks).toBe(before.tasks);
}, 90_000);

test("read, revoked and viewer authority refuse planning or writing without effects", async () => {
	const read = await createPersonalAccessToken(runtime, actor, {
		name: "reader",
		access: "read",
	});
	const before = await counts();
	wires.length = 0;
	const readPlan = await plan(intent(), read.token);
	expect(readPlan.code).toBe(4);
	expect(failure(readPlan).code).toBe("write-token-required");
	expect(writes()).toEqual([]);
	const body = {
		listId: sharedTeam,
		title: "Read token",
		notes: null,
		dueAt: null,
		dueAllDay: false,
		priority: 0,
		assigneeIds: [],
		labelIds: [],
	};
	const readCreate = await cli(
		["create-task", "--request-id", randomUUID()],
		body,
		read.token,
	);
	expect(readCreate.code).toBe(4);
	expect(await counts()).toEqual(before);
	await expectRefused(
		intent({ target: listTarget("Viewer list") }),
		"list-not-found",
		[],
	);
	const viewerCreate = await cli(
		["create-task", "--request-id", randomUUID()],
		{
			...body,
			listId: viewerList,
		},
	);
	expect(viewerCreate.code).toBe(4);
	expect(await counts()).toEqual(before);
	await revokePersonalAccessToken(runtime, actor, tokenId);
	wires.length = 0;
	const revokedPlan = await plan(intent());
	expect(revokedPlan.code).toBe(3);
	const revokedCreate = await cli(
		["create-task", "--request-id", randomUUID()],
		body,
	);
	expect(revokedCreate.code).toBe(3);
	expect(await counts()).toEqual(before);
}, 90_000);

test("actual MCP plans, refuses ambiguity and strict keys, creates by UUID and reads back", async () => {
	pinned = PIN;
	const client = await mcp();
	wires.length = 0;
	const structured = <T>(result: { structuredContent?: unknown }) =>
		result.structuredContent as T;
	const ambiguous = await callTool(client, {
		name: "plan_task",
		arguments: intent({ assignees: [{ name: "Alex" }] }),
	});
	expect(ambiguous.isError).toBe(true);
	const refusal = structured<{ error: Failure }>(ambiguous).error;
	expect(refusal.code).toBe("ambiguous-assignee");
	expect(choiceIds(refusal)).toEqual(sorted([alexA, alexB]));
	expect(writes()).toEqual([]);
	wires.length = 0;
	// The SDK projects input validation failures as text tool errors.
	let strict: {
		isError?: boolean;
		structuredContent?: unknown;
		content?: { type: string; text?: string }[];
	} | null = null;
	let protocolCode: number | null = null;
	try {
		strict = await callTool(client, {
			name: "plan_task",
			arguments: intent({ tag: [{ name: "Alex" }] }),
		});
	} catch (error) {
		if (!(error instanceof ProtocolError)) throw error;
		protocolCode = error.code;
	}
	if (strict === null) {
		expect(protocolCode).toBe(ProtocolErrorCode.InvalidParams);
	} else {
		expect(strict.isError).toBe(true);
		expect(strict.structuredContent).toBeUndefined();
		expect(strict.content).toHaveLength(1);
		expect(strict.content?.[0].type).toBe("text");
		expect(strict.content?.[0].text).toMatch(
			/^Input validation error: Invalid arguments for tool plan_task: /,
		);
	}
	expect(wires).toEqual([]);
	const proposed = await callTool(client, {
		name: "plan_task",
		arguments: intent({
			title: "MCP planned",
			assignees: [{ id: alexA }],
			labels: [{ name: "errand" }],
			due: { day: "tomorrow" },
		}),
	});
	expect(proposed.isError).not.toBe(true);
	const proposal = structured<Plan>(proposed);
	expect(proposal).toMatchObject({
		target: { kind: "dashboard", id: todayDashboard },
		timezone: "Pacific/Kiritimati",
		resolvedAt: PIN,
		task: {
			listId: sharedTasks,
			dueAt: "2026-03-08T22:00:00.000Z",
			dueAllDay: true,
			assigneeIds: [alexA],
			labelIds: [errandLabel],
		},
	});
	expect(writes()).toEqual([]);
	const requestId = randomUUID();
	const created = await callTool(client, {
		name: "create_task",
		arguments: { requestId, task: proposal.task },
	});
	expect(created.isError).not.toBe(true);
	const id = structured<{ data: { id: string } }>(created).data.id;
	expect(writes()).toEqual([
		{ path: "/api/v1/tasks", method: "POST", key: requestId },
	]);
	const listed = await callTool(client, {
		name: "list_tasks",
		arguments: { listId: sharedTasks },
	});
	expect(
		structured<{ data: { id: string }[] }>(listed).data.find(
			(item) => item.id === id,
		),
	).toMatchObject({
		dueAt: "2026-03-08T22:00:00.000Z",
		assigneeIds: [alexA],
		labelIds: [errandLabel],
	});
	const readOnly = await createPersonalAccessToken(runtime, actor, {
		name: "mcp reader",
		access: "read",
	});
	const readClient = await mcp(readOnly.token);
	const denied = await callTool(readClient, {
		name: "plan_task",
		arguments: intent(),
	});
	expect(denied.isError).toBe(true);
	expect(structured<{ error: Failure }>(denied).error.code).toBe(
		"write-token-required",
	);
}, 90_000);
