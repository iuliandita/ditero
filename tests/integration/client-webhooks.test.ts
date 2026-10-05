import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

type Failure = { code: string; status: number | null; message: string };
type Metadata = {
	id: string;
	name: string;
	hint: string;
	listId: string;
	workspaceId: string;
	createdAt: string;
	expiresAt: string;
	revokedAt: string | null;
};
type Created = Metadata & { secret: string };

const databaseURL = process.env.DATABASE_URL;
const expectedDatabase =
	process.env.DITERO_CLIENT_WEBHOOK_TEST_DATABASE ?? "ditero_e2e";
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
const role = `client_hook_${randomUUID().replaceAll("-", "")}`;
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
let before: unknown = null;
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
const WEBHOOK_SECRET = /ditero_whk_[A-Za-z0-9_-]{43}/g;
const secretCount = (text: string) => (text.match(WEBHOOK_SECRET) ?? []).length;
const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");
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
	// No signal goes to a raw PID: it may have been reused after the SDK
	// closed the child. A process that is still present is unproven, and
	// the harness fails closed instead.
	if (session.pid !== null && !(await absent(session.pid, 5000))) {
		unprovenPids.push(session.pid);
		errors.push(new Error("Owned MCP process unproven closed after SDK close"));
	}
	if (errors.length)
		throw new AggregateError(errors, "MCP session close failed");
}

// The real public API routes over the restricted runtime pool, served on a
// loopback listener so the unmodified CLI and MCP processes use real HTTP.
const app = publicApiRoutes(runtime, async () => true);
const wires: {
	path: string;
	method: string | undefined;
	key?: string;
	bearer: "pat" | "hook" | "none";
}[] = [];
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
		const authorization = headers.get("authorization") ?? "";
		wires.push({
			path: incoming.url ?? "",
			method: incoming.method,
			key: headers.get("idempotency-key") ?? undefined,
			bearer: authorization.startsWith("Bearer ditero_pat_")
				? "pat"
				: authorization.startsWith("Bearer ditero_whk_")
					? "hook"
					: "none",
		});
		const response = await app.handle(
			new Request(`${origin}${incoming.url}`, {
				method: incoming.method,
				headers,
				...(body ? { body } : {}),
			}),
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		outgoing.writeHead(response.status, Object.fromEntries(response.headers));
		outgoing.end(bytes);
	} catch {
		outgoing.writeHead(500);
		outgoing.end();
	}
});

// Exact IDs created by the current test, tracked before each insert so a
// failed fixture still cleans up what it created. Hooks and tokens are owned
// through these exact user IDs.
const users: string[] = [];
const workspaces: string[] = [];
const lists: string[] = [];
const hooks: string[] = [];
let actor: string;
let casey: string;
let stranger: string;
let shared: string;
let viewerWorkspace: string;
let decoyWorkspace: string;
let ownList: string;
let viewerList: string;
let decoyList: string;
let token: string;
let tokenId: string;
let readToken: string;

function track(into: string[]) {
	const id = randomUUID();
	into.push(id);
	return id;
}
async function addUser(name: string) {
	const id = track(users);
	await admin.query(
		'insert into "user" (id,name,email,email_verified) values ($1,$2,$3,true)',
		[id, name, `${id}@hook.test`],
	);
	return id;
}
async function addWorkspace(owner: string, members: [string, string][] = []) {
	const id = track(workspaces);
	await admin.query(
		"insert into workspace (id,name,owner_id,kind) values ($1,'Hook shared',$2,'shared')",
		[id, owner],
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

// Every observable piece of state this file may touch, in a form that is
// exactly comparable before the role exists and after it is gone.
async function inventory() {
	const roles = await admin.query(
		`select rolname,oid::text as oid,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit from pg_roles order by rolname`,
	);
	const memberships = await admin.query(
		"select roleid::text,member::text,grantor::text from pg_auth_members order by 1,2,3",
	);
	// A revoked grant may leave an explicit default ACL, so compare defaults.
	const tableGrants = await admin.query(
		`select c.relname,coalesce(c.relacl,acldefault((case c.relkind when 'S' then 's' else 'r' end)::"char",c.relowner))::text as acl
		from pg_class c join pg_namespace n on n.oid=c.relnamespace
		where n.nspname='public' and c.relkind in ('r','p','v','m','f','S') order by c.relname`,
	);
	const schemaGrants = await admin.query(
		`select nspname,coalesce(nspacl,acldefault('n',nspowner))::text as acl from pg_namespace where nspname='public'`,
	);
	const columnGrants = await admin.query(
		`select count(*)::int as count from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and a.attacl is not null`,
	);
	const defaultAcls = await admin.query(
		"select defaclrole::text as role,defaclnamespace::text as namespace,defaclobjtype::text as objtype,defaclacl::text as acl from pg_default_acl order by 1,2,3,4",
	);
	// Shared dependencies of this database and of cluster-wide objects.
	const sharedDependencies = await admin.query(
		`select dbid::text,classid::text,objid::text,objsubid,refclassid::text,refobjid::text,deptype::text
		from pg_shdepend
		where dbid in (0,(select oid from pg_database where datname=current_database()))
		order by 1,2,3,4,5,6,7`,
	);
	// Every public base table: row count plus an ordered content hash. Only
	// table names, counts and hashes are reported, never row data or keys. An
	// empty table hashes to md5(''), so the hash is never null.
	const names = await admin.query<{ name: string }>(
		`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
		where n.nspname='public' and c.relkind in ('r','p') and not c.relispartition order by c.relname`,
	);
	const tables: { table: string; count: number; hash: string }[] = [];
	for (const { name } of names.rows) {
		const content = await admin.query<{ count: number; hash: string }>(
			`select count(*)::int as count,
			coalesce(md5(string_agg(md5(t::text),',' order by md5(t::text))),md5('')) as hash
			from "public"."${name.replaceAll('"', '""')}" as t`,
		);
		tables.push({ table: name, ...content.rows[0] });
	}
	return {
		roles: roles.rows,
		memberships: memberships.rows,
		tableGrants: tableGrants.rows,
		schemaGrants: schemaGrants.rows,
		columnGrants: columnGrants.rows[0],
		defaultAcls: defaultAcls.rows,
		sharedDependencies: sharedDependencies.rows,
		tables,
	};
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
		before = await inventory();
		const statement = await admin.query<{ statement: string }>(
			"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) as statement",
			[role, runtimePassword],
		);
		roleCreated = true;
		await admin.query(statement.rows[0].statement);
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
					"select relrowsecurity,relforcerowsecurity from pg_class where oid='inbound_webhook'::regclass",
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
	actor = await addUser("Hook owner");
	casey = await addUser("Casey");
	stranger = await addUser("Stranger");
	shared = await addWorkspace(actor);
	viewerWorkspace = await addWorkspace(casey, [[actor, "viewer"]]);
	decoyWorkspace = await addWorkspace(stranger);
	ownList = await addList(shared, actor, "Inbox");
	viewerList = await addList(viewerWorkspace, casey, "Viewer list");
	decoyList = await addList(decoyWorkspace, stranger, "Decoy");
	const write = await createPersonalAccessToken(runtime, actor, {
		name: "writer",
		access: "write",
	});
	token = write.token;
	tokenId = write.id;
	readToken = (
		await createPersonalAccessToken(runtime, actor, {
			name: "reader",
			access: "read",
		})
	).token;
}
async function residue() {
	return (
		await admin.query(
			`select (select count(*)::int from "user" where id=any($1::text[])) users,
			(select count(*)::int from workspace where id=any($2::text[])) workspaces,
			(select count(*)::int from list where id=any($3::text[])) lists,
			(select count(*)::int from task where list_id=any($3::text[])) tasks,
			(select count(*)::int from membership where workspace_id=any($2::text[])) memberships,
			(select count(*)::int from inbound_webhook where id=any($4::uuid[]) or user_id=any($1::text[])) hooks,
			(select count(*)::int from personal_access_token where user_id=any($1::text[])) tokens,
			(select count(*)::int from public_api_request where user_id=any($1::text[])) receipts,
			(select count(*)::int from invite where workspace_id=any($2::text[])) invites`,
			[users, workspaces, lists, hooks],
		)
	).rows[0];
}
const noResidue = {
	users: 0,
	workspaces: 0,
	lists: 0,
	tasks: 0,
	memberships: 0,
	hooks: 0,
	tokens: 0,
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
		await step(async () => {
			noLeak(session.stderr(), session.secret, runtimePassword);
			expect({ secrets: secretCount(session.stderr()) }).toEqual({
				secrets: 0,
			});
		});
	}
	// Processes must be proven closed before any fixture SQL runs.
	if (failures.length === 0) {
		const owned = (sql: string, ids: string[], extra?: string[]) =>
			step(() => admin.query(sql, extra ? [ids, extra] : [ids]));
		await owned(
			"delete from public_api_request where user_id=any($1::text[])",
			users,
		);
		await owned("delete from task where list_id=any($1::text[])", lists);
		await owned(
			"delete from inbound_webhook where id=any($1::uuid[]) or user_id=any($2::text[])",
			hooks,
			users,
		);
		await owned(
			"delete from personal_access_token where user_id=any($1::text[])",
			users,
		);
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
		for (const ids of [users, workspaces, lists, hooks]) ids.length = 0;
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
			const found = await admin.query(
				"select oid::text as oid,rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolbypassrls from pg_roles where rolname=$1 or oid=$2::oid",
				[role, roleOid],
			);
			if (found.rows.length === 0) return;
			// Without a recorded OID the role is unproven: no revoke, no drop.
			if (roleOid === null)
				throw new Error(`Role identity unproven, refusing cleanup of ${role}`);
			// Identity check before touching a role this file did not prove it owns.
			expect(found.rows).toEqual([
				{
					oid: roleOid,
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
			expect(
				(
					await admin.query(
						`select (select count(*)::int from pg_class where relowner=r.oid) owned,
						(select count(*)::int from pg_auth_members where member=r.oid or roleid=r.oid or grantor=r.oid) memberships,
						(select count(*)::int from pg_shdepend where refclassid='pg_authid'::regclass and refobjid=r.oid) shared_dependencies,
						(select count(*)::int from pg_default_acl where defaclrole=r.oid) default_acls
						from pg_roles r where r.oid=$1::oid`,
						[roleOid],
					)
				).rows[0],
			).toEqual({
				owned: 0,
				memberships: 0,
				shared_dependencies: 0,
				default_acls: 0,
			});
			// DROP ROLE does not wait for sessions: prove zero by OID or
			// application name first, with a deadline.
			const deadline = Date.now() + 5000;
			for (;;) {
				const open = (
					await admin.query<{ count: number }>(
						"select count(*)::int as count from pg_stat_activity where usesysid=$1::oid or application_name=$2",
						[roleOid, role],
					)
				).rows[0].count;
				if (open === 0) break;
				if (Date.now() >= deadline)
					throw new Error("Runtime sessions still present before role drop");
				await sleep(50);
			}
			// Plain DROP ROLE refuses while any dependency remains.
			await admin.query(`drop role "${role}"`);
		});
	await step(async () => {
		expect(
			(
				await admin.query(
					"select (select count(*)::int from pg_roles where rolname=$2 or oid=$1::oid) roles,(select count(*)::int from pg_stat_activity where usesysid=$1::oid or application_name=$2) sessions",
					[roleOid, role],
				)
			).rows[0],
		).toEqual({ roles: 0, sessions: 0 });
	});
	await step(async () => expect(await residue()).toEqual(noResidue));
	if (before !== null)
		await step(async () => expect(await inventory()).toEqual(before));
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
			`select (select count(*)::int from inbound_webhook where user_id=$1) hooks,
			(select count(*)::int from task where list_id=any($2::text[])) tasks,
			(select count(*)::int from public_api_request where user_id=$1) receipts`,
			[actor, lists],
		)
	).rows[0];
}
async function hookRow(id: string) {
	return (
		await admin.query(
			"select user_id,list_id,workspace_id,name,hint,secret_hash,revoked_at,expires_at,created_at from inbound_webhook where id=$1",
			[id],
		)
	).rows[0];
}
// The CLI is the unmodified Bun entry point; credentials travel only through
// the environment, never through arguments, stdin or the assertion messages.
async function cli(args: string[], body?: unknown, secret = token) {
	if (args.some((argument) => leaks(argument, secret)))
		throw new Error("Credential in CLI arguments");
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
	// A webhook secret may appear once on stdout of a successful create only.
	const reveals = args[0] === "create-webhook" && code === 0 ? 1 : 0;
	expect({ stderr: secretCount(stderr), stdout: secretCount(stdout) }).toEqual({
		stderr: 0,
		stdout: reveals,
	});
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
async function createViaCli(body: unknown, secret = token) {
	const result = await cli(["create-webhook", "--reveal-secret"], body, secret);
	expect(result.code).toBe(0);
	const created = JSON.parse(result.stdout);
	expect(Object.keys(created).sort()).toEqual([
		"data",
		"nextCursor",
		"version",
	]);
	hooks.push(created.data.id);
	return created.data as Created;
}
async function listViaCli(secret = token) {
	const result = await cli(["list-webhooks"], undefined, secret);
	expect(result.code).toBe(0);
	const parsed = JSON.parse(result.stdout);
	expect(parsed).toMatchObject({ version: 1, nextCursor: null });
	return parsed.data as Metadata[];
}
// Real HTTP delivery with the webhook secret as the only credential.
async function deliver(hook: { id: string; secret: string }) {
	const response = await fetch(
		`${origin}/api/v1/webhooks/${hook.id}/deliveries`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${hook.secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ deliveryId: randomUUID(), title: "Client hook" }),
			signal: AbortSignal.timeout(15_000),
		},
	);
	await response.text();
	return response.status;
}
const metadataKeys = [
	"createdAt",
	"expiresAt",
	"hint",
	"id",
	"listId",
	"name",
	"revokedAt",
	"workspaceId",
];

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
		{ name: "actual-client-webhooks", version: "1" },
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
// Input validation may surface as a tool error or a protocol error.
async function refused(
	client: Client,
	params: Parameters<Client["callTool"]>[0],
) {
	try {
		return (await callTool(client, params)).isError === true;
	} catch (error) {
		if (!(error instanceof ProtocolError)) throw error;
		return error.code === ProtocolErrorCode.InvalidParams;
	}
}
const structured = <T>(result: { structuredContent?: unknown }) =>
	result.structuredContent as T;

test("actual CLI create needs explicit reveal, shows the secret once, never replays and lists metadata only", async () => {
	const start = await counts();
	const missing = await cli(["create-webhook"], {
		name: "Hook",
		listId: ownList,
	});
	expect(missing.code).toBe(2);
	expect(failure(missing).code).toBe("reveal_required");
	expect(wires).toEqual([]);
	expect(await counts()).toEqual(start);

	const first = await createViaCli({
		name: "Hook",
		listId: ownList,
		expiresInDays: 30,
	});
	expect(wires).toEqual([
		{ path: "/api/v1/webhooks", method: "POST", key: undefined, bearer: "pat" },
	]);
	expect(Object.keys(first).sort()).toEqual([...metadataKeys, "secret"].sort());
	expect(first).toMatchObject({
		name: "Hook",
		listId: ownList,
		workspaceId: shared,
		revokedAt: null,
	});
	expect(first.secret).toMatch(/^ditero_whk_[A-Za-z0-9_-]{43}$/);
	expect(first.hint).toBe(first.secret.slice(-4));
	const lifetime = Date.parse(first.expiresAt) - Date.parse(first.createdAt);
	expect(Math.abs(lifetime - 30 * 86_400_000)).toBeLessThanOrEqual(3_600_000);
	const stored = await hookRow(first.id);
	expect(stored.secret_hash).toBe(sha256(first.secret));
	noLeak(JSON.stringify(stored), first.secret);
	expect(stored).toMatchObject({
		user_id: actor,
		list_id: ownList,
		workspace_id: shared,
		revoked_at: null,
	});

	// The same body is a new webhook: no request ID, no replay, a fresh secret.
	wires.length = 0;
	const second = await createViaCli({ name: "Hook", listId: ownList });
	expect(wires).toEqual([
		{ path: "/api/v1/webhooks", method: "POST", key: undefined, bearer: "pat" },
	]);
	expect(second.id).not.toBe(first.id);
	expect(second.secret).not.toBe(first.secret);
	expect((await counts()).hooks).toBe(start.hooks + 2);
	expect(await deliver(first)).toBe(201);
	expect(await deliver(second)).toBe(201);

	wires.length = 0;
	const listed = await listViaCli();
	expect(wires).toEqual([
		{ path: "/api/v1/webhooks", method: "GET", key: undefined, bearer: "pat" },
	]);
	// Active first, newest first.
	expect(listed.map((item) => item.id)).toEqual([second.id, first.id]);
	for (const item of listed) {
		expect(Object.keys(item).sort()).toEqual(metadataKeys);
		expect(item.hint).toHaveLength(4);
	}
	expect(await counts()).toEqual({
		hooks: start.hooks + 2,
		tasks: start.tasks + 2,
		receipts: start.receipts + 2,
	});
}, 120_000);

test("actual CLI revoke is repeatable and a revoked webhook rejects delivery", async () => {
	const hook = await createViaCli({ name: "Revocable", listId: ownList });
	const control = await createViaCli({ name: "Control", listId: ownList });
	expect(await deliver(hook)).toBe(201);
	const tasks = (await counts()).tasks;

	wires.length = 0;
	const revoked = await cli(["revoke-webhook", "--webhook", hook.id]);
	expect(revoked.code).toBe(0);
	expect(JSON.parse(revoked.stdout)).toEqual({
		version: 1,
		data: { id: hook.id, revoked: true },
		nextCursor: null,
	});
	expect(wires).toEqual([
		{
			path: `/api/v1/webhooks/${hook.id}`,
			method: "DELETE",
			key: undefined,
			bearer: "pat",
		},
	]);
	const stamp = (await hookRow(hook.id)).revoked_at as Date;
	expect(stamp).toBeInstanceOf(Date);

	const again = await cli(["revoke-webhook", "--webhook", hook.id]);
	expect(again.code).toBe(0);
	expect(JSON.parse(again.stdout).data).toEqual({ id: hook.id, revoked: true });
	expect((await hookRow(hook.id)).revoked_at).toEqual(stamp);

	expect(await deliver(hook)).toBe(401);
	expect((await counts()).tasks).toBe(tasks);
	// Only the revoked webhook is affected; revoked rows sort after active ones.
	expect(await deliver(control)).toBe(201);
	const listed = await listViaCli();
	expect(listed.map((item) => item.id)).toEqual([control.id, hook.id]);
	expect(listed[0].revokedAt).toBeNull();
	expect(listed[1].revokedAt).toBe(stamp.toISOString());

	for (const [args, exit, code] of [
		[["revoke-webhook", "--webhook", randomUUID()], 5, "not_found"],
		[["revoke-webhook", "--webhook", "not-a-uuid"], 2, "invalid_arguments"],
	] as const) {
		wires.length = 0;
		const result = await cli([...args]);
		expect(result.code).toBe(exit);
		expect(failure(result).code).toBe(code);
		expect(wires.length).toBe(exit === 5 ? 1 : 0);
	}
}, 120_000);

test("actual CLI refuses read tokens, viewer and foreign lists, and revoked tokens without effects", async () => {
	const hook = await createViaCli({ name: "Guarded", listId: ownList });
	const start = await counts();
	const body = { name: "Refused", listId: ownList };
	const expectRefused = async (
		args: string[],
		input: unknown,
		secret: string,
		exit: number,
		code: string,
	) => {
		wires.length = 0;
		const result = await cli(args, input, secret);
		expect(result.code).toBe(exit);
		expect(failure(result).code).toBe(code);
		expect(await counts()).toEqual(start);
		expect((await hookRow(hook.id)).revoked_at).toBeNull();
	};
	// A read token cannot manage webhooks, not even to list them.
	await expectRefused(["list-webhooks"], undefined, readToken, 4, "forbidden");
	await expectRefused(
		["create-webhook", "--reveal-secret"],
		body,
		readToken,
		4,
		"forbidden",
	);
	await expectRefused(
		["revoke-webhook", "--webhook", hook.id],
		undefined,
		readToken,
		4,
		"forbidden",
	);
	// A write token still needs a writable seat and a visible list.
	await expectRefused(
		["create-webhook", "--reveal-secret"],
		{ ...body, listId: viewerList },
		token,
		4,
		"forbidden",
	);
	await expectRefused(
		["create-webhook", "--reveal-secret"],
		{ ...body, listId: decoyList },
		token,
		5,
		"not_found",
	);
	expect(await deliver(hook)).toBe(201);

	await revokePersonalAccessToken(runtime, actor, tokenId);
	const afterRevoke = await counts();
	for (const [args, input] of [
		[["list-webhooks"], undefined],
		[["create-webhook", "--reveal-secret"], body],
		[["revoke-webhook", "--webhook", hook.id], undefined],
	] as const) {
		const result = await cli([...args], input);
		expect(result.code).toBe(3);
		expect(failure(result).code).toBe("unauthorized");
	}
	expect(await counts()).toEqual(afterRevoke);
	expect((await hookRow(hook.id)).revoked_at).toBeNull();
}, 120_000);

test("actual CLI list accepts 21 rows with an expired unrevoked webhook that does not count against the cap", async () => {
	const active: string[] = [];
	for (let index = 0; index < 20; index++) {
		const id = track(hooks);
		active.push(id);
		await admin.query(
			"insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,$5,$6,'abcd',statement_timestamp()-make_interval(secs=>$7),statement_timestamp()+interval '30 days')",
			[
				id,
				actor,
				ownList,
				shared,
				`Active ${index}`,
				sha256(randomUUID()),
				index + 1,
			],
		);
	}
	// Expired but never revoked: a fixed past window needs no clock waiting.
	const expired = track(hooks);
	await admin.query(
		"insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,'Expired',$5,'abcd','2020-01-01T00:00:00Z','2020-01-02T00:00:00Z')",
		[expired, actor, ownList, shared, sha256(randomUUID())],
	);
	const listed = await listViaCli();
	expect(listed).toHaveLength(21);
	expect(new Set(listed.map((item) => item.id)).size).toBe(21);
	expect(listed.slice(0, 20).map((item) => item.id)).toEqual(active);
	expect(listed[20]).toMatchObject({ id: expired, revokedAt: null });
	expect(Date.parse(listed[20].expiresAt)).toBeLessThan(Date.now());
	for (const item of listed)
		expect(Object.keys(item).sort()).toEqual(metadataKeys);

	// 20 active webhooks fill the cap; the expired one is not counted.
	const full = await counts();
	const limited = await cli(["create-webhook", "--reveal-secret"], {
		name: "Over cap",
		listId: ownList,
	});
	expect(limited.code).toBe(10);
	expect(failure(limited)).toMatchObject({
		code: "webhook_limit",
		status: 409,
	});
	expect(await counts()).toEqual(full);

	expect((await cli(["revoke-webhook", "--webhook", active[19]])).code).toBe(0);
	const created = await createViaCli({ name: "Fits again", listId: ownList });
	const relisted = await listViaCli();
	expect(relisted).toHaveLength(22);
	expect(relisted[0].id).toBe(created.id);
}, 120_000);

test("actual stdio MCP serves 33 tools and strict, structured webhook create, list and revoke", async () => {
	const client = await mcp();
	const { tools } = await client.listTools();
	expect(tools).toHaveLength(33);
	expect(
		tools
			.map((tool) => tool.name)
			.filter((name) => name.endsWith("_webhook") || name.endsWith("_webhooks"))
			.sort(),
	).toEqual(["create_webhook", "list_webhooks", "revoke_webhook"]);
	const start = await counts();
	wires.length = 0;
	const webhook = { name: "MCP hook", listId: ownList };
	for (const params of [
		{ name: "create_webhook", arguments: { webhook } },
		{ name: "create_webhook", arguments: { revealSecret: false, webhook } },
		{
			name: "create_webhook",
			arguments: { revealSecret: true, webhook: { ...webhook, extra: 1 } },
		},
		{
			name: "create_webhook",
			arguments: {
				revealSecret: true,
				webhook: { ...webhook, expiresInDays: 366 },
			},
		},
		{
			name: "create_webhook",
			arguments: { revealSecret: true, webhook, requestId: randomUUID() },
		},
		{ name: "list_webhooks", arguments: { limit: 1 } },
		{ name: "revoke_webhook", arguments: {} },
		{ name: "revoke_webhook", arguments: { webhookId: "hook" } },
		{
			name: "revoke_webhook",
			arguments: { webhookId: randomUUID(), extra: true },
		},
	])
		expect(await refused(client, params)).toBe(true);
	expect(wires).toEqual([]);
	expect(await counts()).toEqual(start);

	const created = await callTool(client, {
		name: "create_webhook",
		arguments: { revealSecret: true, webhook },
	});
	expect(created.isError).not.toBe(true);
	const envelope = structured<{
		version: number;
		data: Created;
		nextCursor: null;
	}>(created);
	expect(Object.keys(envelope).sort()).toEqual([
		"data",
		"nextCursor",
		"version",
	]);
	expect(envelope).toMatchObject({ version: 1, nextCursor: null });
	const hook = envelope.data;
	hooks.push(hook.id);
	expect(Object.keys(hook).sort()).toEqual([...metadataKeys, "secret"].sort());
	expect(hook.secret).toMatch(/^ditero_whk_[A-Za-z0-9_-]{43}$/);
	expect(hook).toMatchObject({ listId: ownList, workspaceId: shared });
	expect(created.content).toEqual([
		{ type: "text", text: JSON.stringify(created.structuredContent) },
	]);
	expect(wires).toEqual([
		{ path: "/api/v1/webhooks", method: "POST", key: undefined, bearer: "pat" },
	]);
	expect((await hookRow(hook.id)).secret_hash).toBe(sha256(hook.secret));
	expect(await deliver(hook)).toBe(201);

	wires.length = 0;
	const listed = await callTool(client, {
		name: "list_webhooks",
		arguments: {},
	});
	expect(listed.isError).not.toBe(true);
	expect(secretCount(JSON.stringify(listed))).toBe(0);
	const rows = structured<{ data: Metadata[] }>(listed).data;
	expect(rows.map((item) => item.id)).toEqual([hook.id]);
	expect(Object.keys(rows[0]).sort()).toEqual(metadataKeys);
	expect(wires).toEqual([
		{ path: "/api/v1/webhooks", method: "GET", key: undefined, bearer: "pat" },
	]);

	wires.length = 0;
	for (let attempt = 0; attempt < 2; attempt++) {
		const revoked = await callTool(client, {
			name: "revoke_webhook",
			arguments: { webhookId: hook.id.toUpperCase() },
		});
		expect(revoked.isError).not.toBe(true);
		expect(revoked.structuredContent).toEqual({
			version: 1,
			data: { id: hook.id, revoked: true },
			nextCursor: null,
		});
	}
	expect(wires.map((wire) => [wire.method, wire.path, wire.key])).toEqual([
		["DELETE", `/api/v1/webhooks/${hook.id}`, undefined],
		["DELETE", `/api/v1/webhooks/${hook.id}`, undefined],
	]);
	expect(await deliver(hook)).toBe(401);
	const unknown = await callTool(client, {
		name: "revoke_webhook",
		arguments: { webhookId: randomUUID() },
	});
	expect(unknown.isError).toBe(true);
	expect(unknown.structuredContent).toMatchObject({
		error: { status: 404, code: "not_found" },
	});
}, 120_000);

test("actual stdio MCP refuses read tokens, viewer lists and a token revoked mid-session without effects", async () => {
	const live = await createViaCli({ name: "Kept", listId: ownList });
	const start = await counts();
	const reader = await mcp(readToken);
	const body = { name: "Refused", listId: ownList };
	for (const params of [
		{ name: "list_webhooks", arguments: {} },
		{
			name: "create_webhook",
			arguments: { revealSecret: true, webhook: body },
		},
		{ name: "revoke_webhook", arguments: { webhookId: live.id } },
	]) {
		const denied = await callTool(reader, params);
		expect(denied.isError).toBe(true);
		expect(denied.structuredContent).toMatchObject({
			error: { status: 403, code: "forbidden" },
		});
		expect(secretCount(JSON.stringify(denied))).toBe(0);
	}
	expect(await counts()).toEqual(start);
	expect((await hookRow(live.id)).revoked_at).toBeNull();

	const writer = await mcp();
	const viewer = await callTool(writer, {
		name: "create_webhook",
		arguments: { revealSecret: true, webhook: { ...body, listId: viewerList } },
	});
	expect(viewer.isError).toBe(true);
	expect(viewer.structuredContent).toMatchObject({
		error: { status: 403, code: "forbidden" },
	});
	expect(await counts()).toEqual(start);
	// Positive control: the same session works until its token is revoked.
	const control = await callTool(writer, {
		name: "list_webhooks",
		arguments: {},
	});
	expect(control.isError).not.toBe(true);
	await revokePersonalAccessToken(runtime, actor, tokenId);
	for (const params of [
		{ name: "list_webhooks", arguments: {} },
		{
			name: "create_webhook",
			arguments: { revealSecret: true, webhook: body },
		},
		{ name: "revoke_webhook", arguments: { webhookId: live.id } },
	]) {
		const revoked = await callTool(writer, params);
		expect(revoked.isError).toBe(true);
		expect(revoked.structuredContent).toMatchObject({
			error: { status: 401, code: "unauthorized" },
		});
		expect(secretCount(JSON.stringify(revoked))).toBe(0);
	}
	expect(await counts()).toEqual(start);
	expect((await hookRow(live.id)).revoked_at).toBeNull();
}, 120_000);
