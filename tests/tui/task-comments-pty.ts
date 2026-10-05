import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Pool, type QueryResultRow } from "pg";
import { z } from "zod";
import {
	apiCommentIdSchema,
	apiCommentSnapshotSchema,
} from "../../src/domain/public-api-comments.ts";
import * as m from "../../src/paraglide/messages.js";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";

// Actual-PTY qualification of the read-only TUI comments view against the
// production public API. Every database actor is a direct-login role; there is
// no SET ROLE, so the API's authority is the role the session authenticated as.
const modes = [
	"paged",
	"narrow",
	"no-color",
	"arabic",
	"revoked",
	"membership",
];
const mode = process.argv[2] ?? "";
assert.ok(modes.includes(mode), "Unknown terminal fixture case");
if (process.env.TUI_COMMENTS_ENV_FILE) {
	for (const line of readFileSync(
		process.env.TUI_COMMENTS_ENV_FILE,
		"utf8",
	).split("\n")) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line);
		if (match) process.env[match[1]] = match[2];
	}
}
// Budgets (ms). The wrapper repeats these names and proves its parent and
// Vitest timeouts cover startup + body + cleanup + one in-flight statement per
// stage. QUERY_MS is the client-side bound on any one query on either pool.
const BODY_MS = 13000;
const CLEANUP_MS = 8000;
const STATEMENT_MS = 5000;
const CONNECT_MS = 1000;
const QUERY_MS = STATEMENT_MS + CONNECT_MS;
// The four non-DML shutdown awaits; together they fit CLEANUP_MS. The DML
// phases keep their own explicit in-flight allowance in the wrapper.
const CHILD_END_MS = 2000;
const SERVER_STOP_MS = 2000;
const RUNTIME_END_MS = 3000;
const ADMIN_END_MS = 1000;
const QUIET_MS = 50;
// redact:begin
// Pure, so the offline control can drive the actual bytes. Credentials, the
// admin URL and any URL userinfo never survive in a message, stack or name.
const scrubText = (text: string, secrets: readonly string[]) => {
	const variants = secrets.flatMap((secret) => [
		secret,
		encodeURIComponent(secret),
		JSON.stringify(secret).slice(1, -1),
	]);
	const ordered = [...new Set(variants)]
		.filter((secret) => secret.length > 0)
		.sort((a, b) => b.length - a.length);
	return ordered
		.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), text)
		.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/?#]*@/gi, "$1[redacted]@");
};
// A fresh message/stack-only copy: no cause, no assertion actual/expected and no
// other own property can carry the raw value into the parent's output.
const publicError = (error: unknown, secrets: readonly string[]): Error => {
	if (!(error instanceof Error))
		return new Error(
			scrubText(
				error === undefined
					? "Comments fixture failed without an error value"
					: String(error),
				secrets,
			),
		);
	const message = scrubText(error.message, secrets);
	const copy =
		error instanceof AggregateError
			? new AggregateError(
					error.errors.map((inner) => publicError(inner, secrets)),
					message,
				)
			: new Error(message);
	copy.name = scrubText(error.name, secrets);
	copy.stack = scrubText(
		error.stack ?? `${error.name}: ${error.message}`,
		secrets,
	);
	return copy;
};
// redact:end
// quiet:begin
// A frame is actionable only when no data arrived for quietMs and the output
// does not end inside an escape sequence (a frame split across PTY chunks).
const frameComplete = (
	output: string,
	now: number,
	lastDataAt: number,
	quietMs: number,
) =>
	now - lastDataAt >= quietMs &&
	!new RegExp(`${String.fromCharCode(27)}(?:\\[[0-9;?]*)?$`).test(output);
// quiet:end
const secrets: string[] = [];
const databaseURL = process.env.DATABASE_URL;
assert.ok(databaseURL, "A designated fixture database is required");
const adminURL = (() => {
	try {
		return new URL(databaseURL);
	} catch {
		// Never carry the parse failure: its input is the credentialed URL.
		throw new Error("DATABASE_URL is not a parseable URL");
	}
})();
secrets.push(databaseURL, adminURL.password);
try {
	secrets.push(decodeURIComponent(adminURL.password));
} catch {
	// An undecodable password is still redacted in its encoded form above.
}
const expectedDatabase =
	process.env.TUI_COMMENTS_EXPECTED_DATABASE ?? "ditero_e2e";
assert.equal(
	adminURL.pathname,
	`/${expectedDatabase}`,
	"Only the designated fixture database may be used",
);
const captureRoot = process.env.TUI_COMMENTS_CAPTURE_DIR;
if (captureRoot)
	assert.ok(isAbsolute(captureRoot), "Capture directory must be absolute");
const env = (extra: Record<string, string> = {}) => ({
	PATH: process.env.PATH ?? "",
	HOME: process.env.HOME ?? "",
	NODE_ENV: "test",
	...extra,
});
const admin = new Pool({
	connectionString: databaseURL,
	connectionTimeoutMillis: CONNECT_MS,
	statement_timeout: STATEMENT_MS,
	query_timeout: QUERY_MS,
});
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const prefix = `tui_comments_776_${suffix}`;
const role = `${prefix}_runtime`;
const password = randomUUID();
const runtimeURL = new URL(adminURL.href);
runtimeURL.username = role;
runtimeURL.password = password;
secrets.push(password, runtimeURL.toString());
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
	connectionTimeoutMillis: CONNECT_MS,
	statement_timeout: STATEMENT_MS,
	query_timeout: QUERY_MS,
});
const actor = `${prefix}_actor`,
	other = `${prefix}_other`,
	workspace = `${prefix}_workspace`,
	list = `${prefix}_list`,
	membershipId = `${prefix}_membership`,
	emptyTask = `${prefix}_task_a`,
	task = `${prefix}_task_b`,
	decoyTask = `${prefix}_task_c`;
const title = "Comment fixture task";
const locale = mode === "arabic" ? "ar" : "en";
const [columns, rows] =
	mode === "narrow" ? [40, 20] : mode === "arabic" ? [100, 40] : [120, 45];
const PAGE = 50;
// Zero-padded so database "C" collation and numeric order agree: c00..c50.
const commentIds = Array.from(
	{ length: PAGE + 1 },
	(_, index) => `${prefix}_c${String(index).padStart(2, "0")}`,
);
const importedNamespace = randomUUID();
const redactedNamespace = randomUUID();
const claimNamespace = randomUUID();
const claimName = "Imported Claim Name";
const at = (minutes: number) =>
	new Date(Date.UTC(2026, 9, 1, 9, minutes)).toISOString();
const bodyOf = (index: number) =>
	index === 0
		? "native line one\nnative line two"
		: `body-${String(index).padStart(2, "0")}`;
let roleCreated = false;
let server: ReturnType<typeof Bun.serve> | undefined;
let terminal: Bun.Terminal | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
const wires: {
	method: string;
	path: string;
	status: number;
	page?: { ids: string[]; nextCursor: string | null };
}[] = [];
const stages: Record<string, string> = {};
const started = Date.now();
const deadline = started + BODY_MS;
const timeout = setTimeout(() => child?.kill("SIGKILL"), BODY_MS + 1000);
let lastDataAt = started;
const sgr = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const frames = () => output.split("\x1b[H\x1b[2J").length;
const frame = () =>
	(output.split("\x1b[H\x1b[2J").at(-1) ?? "").replace(sgr, "");
// Every transition waits for its content AND a quiescent, fully delivered frame,
// so a clear-prefix alone never lets a partial frame be read.
const wait = async (predicate: () => boolean, message: string) => {
	while (
		!(predicate() && frameComplete(output, Date.now(), lastDataAt, QUIET_MS))
	) {
		if (Date.now() > deadline)
			throw new Error(
				`${message}\n${scrubText(frame(), secrets).slice(0, 4000)}`,
			);
		await Bun.sleep(5);
	}
};
const nextFrame = () => {
	const previous = frames();
	return () => frames() > previous;
};
const send = async (keys: string, predicate: () => boolean) => {
	terminal?.write(keys);
	await wait(predicate, "Expected terminal transition was absent");
};
// guard:begin
// Checked before every body query await, so no sequence starts a statement
// after the body deadline. An in-flight statement is never abandoned (it ends
// within QUERY_MS), so cleanup cannot race body DML.
const checkpoint = (what: string) => {
	if (Date.now() > deadline)
		throw new Error(`Body budget exhausted during ${what}`);
};
// Body-only typed wrapper; the SQL and values pass through untouched. Cleanup
// queries call the pool directly and are never gated by the body deadline.
const bodyQuery = <R extends QueryResultRow = QueryResultRow>(
	pool: Pool,
	text: string,
	values?: unknown[],
) => {
	checkpoint("body query");
	return pool.query<R>(text, values);
};
// guard:end
const stage = (name: string) => {
	stages[name] = frame();
};
const commentReads = () =>
	wires.filter((wire) => wire.path.includes(`/tasks/${task}/comments`));
const selectedTitle = () =>
	frame()
		.split("\n")
		.some((line) => {
			const row = line.replace(/^[\s│|]+|[\s│|]+$/g, "");
			const marker = /^>\s+(?:○|\( \)|\[ \])\s+/;
			return (
				marker.test(row) &&
				new RegExp(`^${title}(?:\\s{2,}|$)`).test(row.replace(marker, ""))
			);
		});
const digest = async () =>
	(
		await bodyQuery(
			admin,
			`select md5(coalesce(string_agg(row_to_json(c)::text,'|' order by c.id collate "C"),'')) as comments,count(*)::int as count from comment c where c.task_id=any($1::text[])`,
			[[emptyTask, task, decoyTask]],
		)
	).rows[0];
const tableState = async () =>
	(
		await bodyQuery(
			admin,
			`select (select count(*)::int from public_api_request where user_id=any($1::text[])) as receipts,
	(select count(*)::int from task where list_id=$2) as tasks,
	(select count(*)::int from membership where workspace_id=$3) as memberships,
	(select md5(coalesce(string_agg(row_to_json(t)::text,'|' order by t.id),'')) from task t where t.list_id=$2) as task_digest`,
			[[actor, other], list, workspace],
		)
	).rows[0];
const cleanupCounts = async () =>
	(
		await admin.query(
			`select (select count(*)::int from pg_roles where rolname=$1) as roles,
	(select count(*)::int from pg_stat_activity where usename=$1) as sessions,
	(select count(*)::int from comment where id like $2 or task_id like $2) as comments,
	(select count(*)::int from task where id like $2) as tasks,
	(select count(*)::int from list where id like $2) as lists,
	(select count(*)::int from membership where id like $2) as memberships,
	(select count(*)::int from workspace where id like $2) as workspaces,
	(select count(*)::int from "user" where id like $2) as users,
	(select count(*)::int from personal_access_token where user_id like $2) as tokens,
	(select count(*)::int from user_pref where id like $2) as prefs,
	(select count(*)::int from public_api_request where user_id like $2) as receipts`,
			[role, `${prefix}%`],
		)
	).rows[0];
const pageSchema = z
	.object({
		data: z.array(apiCommentSnapshotSchema),
		nextCursor: z.string().min(1).nullable(),
	})
	.passthrough();
let passed = false;
// settle:begin
type Outcome = { failed: boolean; error?: unknown };
type CleanupFailure = { phase: string; error: unknown };
// A body failure is rethrown as the very same object and cleanup failures never
// replace it. Cleanup failures alone turn a passing body into a non-PASS.
const settle = (outcome: Outcome, cleanup: readonly CleanupFailure[]) => {
	if (outcome.failed) return { pass: false, error: outcome.error };
	if (cleanup.length)
		return {
			pass: false,
			error: new AggregateError(
				cleanup.map((failure) => failure.error),
				`Comments fixture cleanup failed: ${cleanup.map((failure) => failure.phase).join(", ")}`,
			),
		};
	return { pass: true, error: undefined };
};
// settle:end
let outcome: Outcome = { failed: false };
try {
	// Fixture is provisioned by the designated runner; this driver never migrates.
	assert.equal(
		(await bodyQuery(admin, "select current_database() as database")).rows[0]
			.database,
		expectedDatabase,
	);
	const statement = await bodyQuery<{ statement: string }>(
		admin,
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) as statement",
		[role, password],
	);
	await bodyQuery(admin, statement.rows[0].statement);
	roleCreated = true;
	await bodyQuery(admin, `grant usage on schema public to "${role}"`);
	await bodyQuery(
		admin,
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	assert.deepEqual(
		(
			await bodyQuery(
				runtime,
				`select current_user=$1 as current_is_role,session_user=$1 as session_is_role,rolsuper,rolbypassrls,rolinherit,rolcanlogin,
	(select count(*)::int from pg_auth_members where member=r.oid) as forward_grants,
	(select count(*)::int from pg_auth_members where roleid=r.oid) as inverse_grants,
	(select count(*)::int from pg_class where relowner=r.oid) as owned_relations,
	(select count(*)::int from pg_proc where proowner=r.oid) as owned_functions,
	(select count(*)::int from pg_namespace where nspowner=r.oid) as owned_schemas
	from pg_roles r where rolname=current_user`,
				[role],
			)
		).rows[0],
		{
			current_is_role: true,
			session_is_role: true,
			rolsuper: false,
			rolbypassrls: false,
			rolinherit: false,
			rolcanlogin: true,
			forward_grants: 0,
			inverse_grants: 0,
			owned_relations: 0,
			owned_functions: 0,
			owned_schemas: 0,
		},
	);
	{
		// The runtime must not be able to become the fixture owner.
		const adminRole = (await bodyQuery(admin, "select current_user as name"))
			.rows[0].name as string;
		checkpoint("runtime probe connect");
		const probe = await runtime.connect();
		try {
			checkpoint("runtime probe query");
		} catch (error) {
			probe.release(true);
			throw error;
		}
		const rejected = await probe.query(`set role "${adminRole}"`).then(
			() => "no rejection",
			(error: unknown) =>
				error instanceof Error ? error.message : String(error),
		);
		probe.release(true);
		assert.match(rejected, /permission denied/);
	}
	for (const id of [actor, other])
		await bodyQuery(
			admin,
			'insert into "user"(id,name,email,email_verified) values($1,$1,$2,true)',
			[id, `${id}@tui.test`],
		);
	await bodyQuery(
		admin,
		"insert into workspace(id,name,owner_id,kind) values($1,'Comments workspace',$2,'shared')",
		[workspace, actor],
	);
	await bodyQuery(
		admin,
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[membershipId, actor, workspace],
	);
	await bodyQuery(
		admin,
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Comments list','a0')",
		[list, workspace, actor],
	);
	await bodyQuery(
		admin,
		"insert into user_pref(id,timezone,timezone_chosen,locale) values($1,'Europe/Berlin',true,$2)",
		[actor, locale],
	);
	await bodyQuery(
		admin,
		"insert into task(id,list_id,title,sort_key) values($1,$4,'Empty task','a0'),($2,$4,$5,'a1'),($3,$4,'Decoy task','a2')",
		[emptyTask, task, decoyTask, list, title],
	);
	// Native rows: author required, every provenance column null. Imported rows
	// satisfy comment_provenance: author null, source key and importedAt set; a
	// source_claim needs a namespace, unknown needs none, only unknown may be
	// redacted. No encryption keys or attachment blobs are involved.
	for (const [index, id] of commentIds.entries()) {
		const base = [id, task, bodyOf(index), at(index)];
		if (index === 1)
			await bodyQuery(
				admin,
				"insert into comment(id,task_id,body,created_at,author_id,source_namespace,source_row_id,historical_author_kind,historical_author_namespace,historical_author_principal_id,historical_author_name,imported_at) values($1,$2,$3,$4,null,$5,$6,'source_claim',$7,'claim-principal',$8,$9)",
				[
					...base,
					importedNamespace,
					`${prefix}_src_01`,
					claimNamespace,
					claimName,
					at(600),
				],
			);
		else if (index === 2 || index === 3)
			await bodyQuery(
				admin,
				"insert into comment(id,task_id,body,created_at,author_id,source_namespace,source_row_id,historical_author_kind,imported_at,provenance_redacted_at) values($1,$2,$3,$4,null,$5,$6,'unknown',$7,$8)",
				[
					...base,
					redactedNamespace,
					`${prefix}_src_0${index}`,
					at(600),
					index === 3 ? at(700) : null,
				],
			);
		else
			await bodyQuery(
				admin,
				"insert into comment(id,task_id,body,created_at,author_id,edited_at) values($1,$2,$3,$4,$5,$6)",
				[...base, index % 2 ? other : actor, index === 4 ? at(800) : null],
			);
	}
	await bodyQuery(
		admin,
		"insert into comment(id,task_id,body,created_at,author_id) values($1,$2,'DECOY-never-read',$3,$4)",
		[`${prefix}_decoy`, decoyTask, at(0), actor],
	);
	// The token helper queries the runtime pool (bounded by QUERY_MS) itself.
	checkpoint("token creation");
	const pat = await createPersonalAccessToken(runtime, actor, {
		name: "Terminal comments fixture",
		access: "read",
	});
	secrets.push(pat.token);
	const seededComments = await digest();
	const seededTables = await tableState();
	const app = publicApiRoutes(runtime, async () => true);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const wire: (typeof wires)[number] = {
				method: request.method,
				path: `${url.pathname}${url.search}`,
				status: 0,
			};
			wires.push(wire);
			const response = await app.handle(request);
			wire.status = response.status;
			if (
				request.method === "GET" &&
				response.ok &&
				url.pathname === `/api/v1/tasks/${task}/comments`
			) {
				const parsed = pageSchema.parse(await response.clone().json());
				wire.page = {
					ids: parsed.data.map((comment) => comment.commentId),
					nextCursor: parsed.nextCursor,
				};
			}
			return response;
		},
	});
	const decoder = new TextDecoder();
	terminal = new Bun.Terminal({
		cols: columns,
		rows,
		data(_terminal, bytes) {
			output += decoder.decode(bytes, { stream: true });
			lastDataAt = Date.now();
		},
	});
	const flags = [
		terminal.inputFlags,
		terminal.outputFlags,
		terminal.localFlags,
		terminal.controlFlags,
	];
	child = Bun.spawn(
		[process.execPath, "run", "src/tui/index.ts", "--allow-loopback-http"],
		{
			terminal,
			env: env({
				DITERO_URL: `http://127.0.0.1:${server.port}`,
				DITERO_TOKEN: pat.token,
				TERM: "xterm-256color",
				COLORFGBG: locale === "ar" ? "15;0" : "0;15",
				...(mode === "no-color" ? { NO_COLOR: "1" } : {}),
			}),
		},
	);
	await wait(
		() =>
			wires.some((wire) => wire.path === "/api/v1/me" && wire.status === 200) &&
			frames() > 1,
		"Startup did not finish",
	);
	await send("\x1b[B\r", () => frame().includes("Comments list"));
	await send("\r", () => frame().includes(title));
	// Select task B by moving down from wherever the first row starts; the list
	// is not assumed to hold only one entry.
	for (let step = 0; step < 4 && !selectedTitle(); step++)
		await send("\x1b[B", nextFrame());
	assert.ok(selectedTitle(), "Task B must be selected before opening comments");
	stage("task-list");
	const number = new Intl.NumberFormat(locale);
	const status = (count: number, page: number, more: boolean) =>
		[
			m.tui_loaded({ count: number.format(count) }, { locale }),
			...(columns >= 60
				? [m.tui_page({ page: number.format(page) }, { locale })]
				: []),
			more ? m.tui_more({}, { locale }) : m.tui_end({}, { locale }),
		].join(" | ");
	await send("m", () => frame().includes(status(PAGE, 1, true)));
	stage("comments-page-1");
	assert.equal(commentReads().length, 1);
	const first = commentReads()[0];
	assert.equal(first.method, "GET");
	assert.equal(first.status, 200);
	assert.equal(first.path, `/api/v1/tasks/${task}/comments?limit=${PAGE}`);
	assert.deepEqual(first.page?.ids, commentIds.slice(0, PAGE));
	assert.equal(typeof first.page?.nextCursor, "string");
	for (const id of commentIds) apiCommentIdSchema.parse(id);
	const visible = frame();
	if (mode !== "narrow") {
		assert.ok(visible.includes("native line one"));
		assert.ok(visible.includes("native line two"));
		assert.ok(
			visible.includes(
				m.tui_comment_imported_author({ name: claimName }, { locale }),
			),
		);
		assert.ok(visible.includes(m.tui_comment_imported_unknown({}, { locale })));
		assert.ok(visible.includes(m.tui_comments_task({ title }, { locale })));
		assert.equal(visible.includes("DECOY"), false);
	}
	if (mode === "narrow") {
		const lines = visible.split(/\r?\n/);
		assert.ok(lines.length <= rows);
		assert.ok(lines.every((line) => line.length <= columns));
	}
	if (mode === "arabic") assert.ok(/[؀-ۿ]/.test(visible));
	if (mode === "paged" || mode === "arabic") {
		// Exact JSON for the highlighted payload is the server's page, unaltered.
		await send("v", () => frame().includes('"commentId"'));
		stage("payload");
		assert.ok(frame().includes(commentIds[0]));
		await send("v", () => !frame().includes('"commentId"'));
		assert.equal(commentReads().length, 1, "Toggling payload must not refetch");
	}
	if (mode === "revoked" || mode === "membership") {
		if (mode === "revoked") {
			checkpoint("token revocation");
			await revokePersonalAccessToken(runtime, actor, pat.id);
		} else
			await bodyQuery(
				admin,
				"delete from membership where id=$1 and user_id=$2 and workspace_id=$3",
				[membershipId, actor, workspace],
			);
		await send(
			"r",
			() => commentReads().length === 2 && wires.at(-1)?.status !== 0,
		);
		await wait(
			() =>
				frame().includes(m.tui_error({ code: "" }, { locale }).slice(0, 10)),
			"Authority loss was not displayed",
		);
		stage("authority-lost");
		// A revoked token is 401; removed membership hides the task as 404.
		assert.equal(commentReads()[1].status, mode === "revoked" ? 401 : 404);
		const gone = frame();
		for (const needle of [
			"body-0",
			"native line",
			claimName,
			title,
			commentIds[0],
			"Comment ID",
		])
			assert.equal(gone.includes(needle), false, `Stale ${needle} remained`);
		assert.equal(commentReads().length, 2);
		await send("q", () => child?.exitCode !== null);
	} else {
		// Page 2 is bounded by the opaque server cursor, never by a CLI --all loop.
		// second-page-ready:begin
		await send("p", () =>
			mode === "narrow"
				? commentReads().length === 2 && frame().includes(bodyOf(PAGE))
				: frame().includes(status(1, 2, false)),
		);
		// second-page-ready:end
		stage("comments-page-2");
		const reads = commentReads();
		assert.equal(reads.length, 2);
		assert.equal(reads[1].status, 200);
		assert.equal(
			reads[1].path,
			`/api/v1/tasks/${task}/comments?limit=${PAGE}&cursor=${encodeURIComponent(first.page?.nextCursor ?? "")}`,
		);
		assert.deepEqual(reads[1].page, {
			ids: [commentIds[PAGE]],
			nextCursor: null,
		});
		if (mode !== "narrow") {
			assert.ok(frame().includes(bodyOf(PAGE)));
			assert.equal(frame().includes(bodyOf(0).split("\n")[0]), false);
		}
		terminal.write("p");
		await Bun.sleep(60);
		assert.equal(
			commentReads().length,
			2,
			"No page exists past the last cursor",
		);
		const beforeEscape = wires.length;
		await send(
			"\x1b",
			() => selectedTitle() && !frame().includes("Comment ID"),
		);
		stage("task-list-after-escape");
		assert.equal(wires.length, beforeEscape, "Esc must not refetch the list");
		assert.ok(selectedTitle(), "Esc must restore the original selected task");
		await send("q", () => child?.exitCode !== null);
	}
	// Every branch already waited for exit inside the body budget; never an
	// unbounded await on the child here.
	assert.equal(child.exitCode, 0);
	assert.deepEqual(
		[
			terminal.inputFlags,
			terminal.outputFlags,
			terminal.localFlags,
			terminal.controlFlags,
		],
		flags,
	);
	assert.equal(output.includes(pat.token), false);
	if (mode === "no-color") assert.equal(output.match(sgr), null);
	else assert.ok(output.match(sgr), "Colour mode must emit SGR styling");
	// Read-only: only GET crossed the transport, nothing was written.
	assert.deepEqual(
		[...new Set(wires.map((wire) => wire.method))],
		["GET"],
		"Only GET may cross the transport",
	);
	assert.equal(
		wires.some((wire) => wire.path.includes(`/tasks/${decoyTask}`)),
		false,
	);
	assert.deepEqual(await digest(), seededComments);
	const finalTables = await tableState();
	assert.equal(finalTables.receipts, 0);
	assert.deepEqual(
		{ ...finalTables, memberships: undefined },
		{ ...seededTables, memberships: undefined },
	);
	assert.equal(
		finalTables.memberships,
		mode === "membership" ? 0 : seededTables.memberships,
	);
	if (captureRoot) {
		// Private evidence for the later PNG renderer: raw ANSI plus the plain
		// frame at each semantic stage. Files are exclusive-create, owner-only.
		mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
		const base = join(captureRoot, `task-comments-${mode}`);
		writeFileSync(`${base}.ansi`, output, { flag: "wx", mode: 0o600 });
		writeFileSync(
			`${base}.proof.json`,
			JSON.stringify(
				{
					mode,
					columns,
					rows,
					locale,
					wires: wires.map(({ page, ...wire }) => ({
						...wire,
						pageSize: page?.ids.length,
						hasNext: page ? page.nextCursor !== null : undefined,
					})),
					stages: Object.fromEntries(
						Object.entries(stages).map(([name, text]) => [
							name,
							{
								sha256: createHash("sha256").update(text).digest("hex"),
								text,
							},
						]),
					),
				},
				null,
				2,
			),
			{ flag: "wx", mode: 0o600 },
		);
	}
	passed = true;
} catch (error) {
	// Held, not thrown: cleanup below must run and the original error object
	// must be the one that finally propagates.
	outcome = { failed: true, error };
}
clearTimeout(timeout);
// Cleanup starts only after the body has fully returned or thrown, so no seed
// statement can still be running. Its own budget is separate from the body's
// (and never borrows from it); a phase that would start past it is recorded as
// a failure instead of being left for the wrapper's SIGTERM to cut off silently.
const cleanupDeadline = Date.now() + CLEANUP_MS;
const cleanupFailures: CleanupFailure[] = [];
const attempt = async (phase: string, fn: () => Promise<unknown>) => {
	if (Date.now() > cleanupDeadline) {
		cleanupFailures.push({
			phase,
			error: new Error("Cleanup budget exhausted before this phase started"),
		});
		return;
	}
	try {
		await fn();
	} catch (error) {
		cleanupFailures.push({ phase, error });
	}
};
// Every shutdown await (child, server, both pools) gets an explicit bound.
// Cleanup DML is bounded by statement_timeout and query_timeout and is never
// abandoned mid-flight.
const bounded = <T>(work: Promise<T>, ms: number, what: string) =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`${what} exceeded ${ms}ms`)),
			ms,
		);
		work.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
await attempt("child", async () => {
	if (child && child.exitCode === null) {
		child.kill("SIGKILL");
		await bounded(child.exited, CHILD_END_MS, "child exit");
	}
});
await attempt("terminal", async () => terminal?.close());
await attempt("server", async () => {
	if (server) await bounded(server.stop(true), SERVER_STOP_MS, "server stop");
});
await attempt("runtime-pool", () =>
	bounded(runtime.end(), RUNTIME_END_MS, "runtime pool end"),
);
// Explicit, FK-ordered, fixture-scoped deletes: comments and tasks before
// the list, membership before the workspace, user last (tokens and
// projections cascade natively). No DROP OWNED, CASCADE or database drops.
for (const [phase, sql, values] of [
	[
		"delete-comments",
		"delete from comment where task_id like $1",
		[`${prefix}%`],
	],
	[
		"delete-tasks",
		"delete from task where id like $1 and list_id=$2",
		[`${prefix}%`, list],
	],
	[
		"delete-list",
		"delete from list where id=$1 and workspace_id=$2",
		[list, workspace],
	],
	[
		"delete-membership",
		"delete from membership where workspace_id=$1 and id like $2",
		[workspace, `${prefix}%`],
	],
	["delete-workspace", "delete from workspace where id=$1", [workspace]],
	["delete-user-pref", "delete from user_pref where id=$1", [actor]],
	[
		"delete-users",
		'delete from "user" where id=any($1::text[])',
		[[actor, other]],
	],
] as const)
	await attempt(phase, () => admin.query(sql, [...values]));
// The role is looked up rather than trusted to a flag, so a create whose reply
// was lost, or a half-applied grant, is still revoked and dropped.
let roleLive = roleCreated;
await attempt("role-lookup", async () => {
	roleLive =
		(await admin.query("select 1 from pg_roles where rolname=$1", [role]))
			.rowCount === 1;
});
if (roleLive) {
	await attempt("revoke-tables", () =>
		admin.query(
			`revoke select,insert,update,delete on all tables in schema public from "${role}"`,
		),
	);
	await attempt("revoke-schema", () =>
		admin.query(`revoke usage on schema public from "${role}"`),
	);
	// Wait for the pool's backends to disappear before dropping the role.
	await attempt("backend-drain", async () => {
		for (let i = 0; i < 40 && Date.now() <= cleanupDeadline; i++) {
			const open = (
				await admin.query(
					"select count(*)::int count from pg_stat_activity where usename=$1",
					[role],
				)
			).rows[0].count;
			if (!open) return;
			await Bun.sleep(50);
		}
		throw new Error("Runtime role backends did not disappear");
	});
	await attempt("drop-role", () => admin.query(`drop role "${role}"`));
}
let finalCounts: Awaited<ReturnType<typeof cleanupCounts>> | undefined;
await attempt("residue-counts", async () => {
	finalCounts = await cleanupCounts();
	assert.deepEqual(finalCounts, {
		roles: 0,
		sessions: 0,
		comments: 0,
		tasks: 0,
		lists: 0,
		memberships: 0,
		workspaces: 0,
		users: 0,
		tokens: 0,
		prefs: 0,
		receipts: 0,
	});
});
await attempt("admin-pool", () =>
	bounded(admin.end(), ADMIN_END_MS, "admin pool end"),
);
const settled = settle(outcome, cleanupFailures);
if (!settled.pass) {
	// Private evidence first, then the original error. Cleanup failures ride
	// along in the record, never in place of the cause.
	const scrub = (text: string) => scrubText(text, secrets);
	const describe = (error: unknown) =>
		scrub(publicError(error, secrets).stack ?? "Unknown failure");
	try {
		if (captureRoot) {
			mkdirSync(captureRoot, { recursive: true, mode: 0o700 });
			// Wires, stages and the last frames, scrubbed twice: per field and over
			// the serialized text. Frame and ANSI are scrubbed whole and only then
			// truncated, so a secret split by the cut is never left half-visible.
			// The record keeps a scrubbed ANSI tail, never the full raw capture.
			const record = {
				mode,
				prefix,
				role,
				elapsedMs: Date.now() - started,
				budgets: { bodyMs: BODY_MS, cleanupMs: CLEANUP_MS },
				childExitCode: child?.exitCode ?? null,
				cause: outcome.failed ? describe(outcome.error) : null,
				cleanup: cleanupFailures.map(({ phase, error }) => ({
					phase,
					error: describe(error),
				})),
				counts: finalCounts ?? null,
				wires: wires.map(({ page, path, ...wire }) => ({
					...wire,
					path: scrub(path),
					pageSize: page?.ids.length,
					hasNext: page ? page.nextCursor !== null : undefined,
				})),
				stages: Object.fromEntries(
					Object.entries(stages).map(([name, text]) => [
						name,
						{
							sha256: createHash("sha256").update(text).digest("hex"),
							text: scrub(text),
						},
					]),
				),
				lastFrame: scrub(frame()).slice(0, 4000),
				ansiTail: scrub(output).slice(-8000),
			};
			writeFileSync(
				join(captureRoot, `task-comments-${mode}.failure.json`),
				scrub(JSON.stringify(record, null, 2)),
				{ flag: "wx", mode: 0o600 },
			);
		}
	} catch (error) {
		process.stderr.write(`Failure record not retained: ${describe(error)}\n`);
	}
	// Bounded and secret-free: phase names and the prefix-scoped residue counts.
	process.stderr.write(
		`${JSON.stringify({
			mode,
			prefix,
			cleanupPhases: cleanupFailures.map(({ phase }) => phase),
			counts: finalCounts ?? null,
		})}\n`,
	);
	// The settle decision keeps the original first cause; only the copy that
	// leaves this process is redacted.
	throw publicError(settled.error, secrets);
}
assert.ok(passed);
process.stdout.write(
	JSON.stringify({
		mode,
		passed,
		requests: wires.length,
		writes: 0,
		cleanup: true,
		directLogin: true,
	}),
);
