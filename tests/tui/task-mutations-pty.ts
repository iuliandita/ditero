import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";

const modes = [
	"update",
	"update-retry",
	"update-uncertain",
	"delete-cascade",
	"delete-retry",
	"conflict",
	"revoked",
	"read",
	"arabic",
];
const mode = process.argv[2] ?? "";
assert.ok(modes.includes(mode), "Unknown terminal fixture case");
if (process.env.TUI_MUTATIONS_ENV_FILE) {
	for (const line of readFileSync(
		process.env.TUI_MUTATIONS_ENV_FILE,
		"utf8",
	).split("\n")) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line);
		if (match) process.env[match[1]] = match[2];
	}
}
const databaseURL = process.env.DATABASE_URL;
assert.ok(databaseURL, "A designated fixture database is required");
const env = (extra: Record<string, string> = {}) => ({
	PATH: process.env.PATH ?? "",
	HOME: process.env.HOME ?? "",
	NODE_ENV: "test",
	...extra,
});
const admin = new Pool({
	connectionString: databaseURL,
	connectionTimeoutMillis: 1000,
	statement_timeout: 5000,
});
const suffix = randomUUID().replaceAll("-", "");
const role = `tui_mutations_${suffix}`;
const password = randomUUID();
const runtimeURL = new URL(databaseURL);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({
	connectionString: runtimeURL.toString(),
	application_name: role,
	connectionTimeoutMillis: 1000,
	statement_timeout: 5000,
});
const actor = randomUUID(),
	workspace = randomUUID(),
	list = randomUUID();
const [childTask, task] = [randomUUID(), randomUUID()].sort();
const title = "Protected terminal task";
const notSent = mode === "arabic" ? "لم يُرسل" : "NOT SENT";
const unconfirmed = mode === "arabic" ? "غير مؤكد" : "UNCONFIRMED";
let roleCreated = false;
let server: ReturnType<typeof Bun.serve> | undefined;
let terminal: Bun.Terminal | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
const wires: {
	method: string;
	path: string;
	key: string | null;
	body: string;
	status: number;
}[] = [];
const startedAt = Date.now();
const deadline = startedAt + 13000;
let stage = "setup: create restricted role";
let stageStartedAt = startedAt;
let setupFinishedAt: number | undefined;
let diagnosticToken: string | undefined;
const enterStage = (name: string) => {
	stage = name;
	stageStartedAt = Date.now();
};
const timeout = setTimeout(() => child?.kill("SIGKILL"), 14000);
const frame = () =>
	(output.split("\x1b[H\x1b[2J").at(-1) ?? "").replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
		"",
	);
const frames = () => output.split("\x1b[H\x1b[2J").length;
const writes = () =>
	wires.filter((wire) => ["PATCH", "DELETE"].includes(wire.method));
const wait = async (predicate: () => boolean, message: string) => {
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
};
const send = async (name: string, keys: string, predicate?: () => boolean) => {
	enterStage(name);
	const previous = frames();
	terminal?.write(keys);
	await wait(
		predicate ?? (() => frames() > previous),
		"Expected terminal transition was absent",
	);
};
const failureDiagnostic = () => {
	const now = Date.now();
	const secrets = [diagnosticToken, ...wires.map((wire) => wire.key)].filter(
		(value): value is string => Boolean(value),
	);
	let latestFrame = frame();
	for (const secret of secrets)
		latestFrame = latestFrame.replaceAll(secret, "[redacted]");
	latestFrame = latestFrame
		.replace(/[^\S\r\n]+$/gm, "")
		.split("")
		.filter((character) => {
			const code = character.charCodeAt(0);
			return code === 10 || code === 13 || (code >= 32 && code !== 127);
		})
		.join("")
		.split(/\r?\n/)
		.slice(0, 64)
		.map((line) =>
			/[{}]|idempotency|authorization|token/i.test(line)
				? "[request details omitted]"
				: line.slice(0, 160),
		)
		.join("\n")
		.slice(0, 8192);
	return {
		mode,
		stage,
		elapsedMs: now - startedAt,
		setupElapsedMs: (setupFinishedAt ?? now) - startedAt,
		transitionElapsedMs: now - stageStartedAt,
		latestFrame,
		wires: wires
			.slice(-64)
			.map(({ method, path, status }) => ({ method, path, status })),
	};
};
const rows = async () =>
	(
		await admin.query(
			"select title,notes,due_at,due_all_day,priority from task where id=$1",
			[task],
		)
	).rows;
const receipts = async () =>
	(
		await admin.query(
			"select count(*)::int count from public_api_request where user_id=$1",
			[actor],
		)
	).rows[0].count;
let passed = false;
try {
	await admin.query(
		`create role "${role}" login password '${password}' nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	assert.deepEqual(
		(
			await runtime.query(
				"select current_user=session_user as direct_login,rolsuper,rolbypassrls,rolinherit,rolcanlogin,exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=current_user)) as member from pg_roles where rolname=current_user",
			)
		).rows[0],
		{
			direct_login: true,
			rolsuper: false,
			rolbypassrls: false,
			rolinherit: false,
			rolcanlogin: true,
			member: false,
		},
	);
	enterStage("setup: seed task scope");
	await admin.query(
		`insert into "user"(id,name,email,email_verified) values($1,'Terminal actor',$2,true)`,
		[actor, `${suffix}@terminal.test`],
	);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Terminal workspace',$2,'shared')",
		[workspace, actor],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[randomUUID(), actor, workspace],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Terminal list','a0')",
		[list, workspace, actor],
	);
	await admin.query(
		"insert into user_pref(id,timezone,timezone_chosen,locale) values($1,'Europe/Berlin',true,$2)",
		[actor, mode === "arabic" ? "ar" : "en"],
	);
	await admin.query(
		"insert into task(id,list_id,title,notes,sort_key) values($1,$2,$3,$4,'a0')",
		[task, list, title, "first\nsecond"],
	);
	if (mode === "delete-cascade") {
		await admin.query(
			"insert into task(id,list_id,title,parent_id,sort_key) values($1,$2,'Child',$3,'a1')",
			[childTask, list, task],
		);
		await admin.query(
			"insert into comment(id,task_id,author_id,body) values($1,$2,$3,'Synthetic dependent comment')",
			[randomUUID(), childTask, actor],
		);
	}
	enterStage("setup: create PAT and API server");
	const pat = await createPersonalAccessToken(runtime, actor, {
		name: "Terminal mutation fixture",
		access: mode === "read" ? "read" : "write",
	});
	diagnosticToken = pat.token;
	const app = publicApiRoutes(runtime, async () => true);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const wire = {
				method: request.method,
				path: new URL(request.url).pathname,
				key: request.headers.get("idempotency-key"),
				body: await request.clone().text(),
				status: 0,
			};
			wires.push(wire);
			const response = await app.handle(request);
			wire.status = response.status;
			if (
				["update-retry", "update-uncertain", "delete-retry"].includes(mode) &&
				writes().length === 1 &&
				["PATCH", "DELETE"].includes(request.method) &&
				response.ok
			) {
				await response.arrayBuffer();
				return new Response("{", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return response;
		},
	});
	enterStage("setup: start terminal");
	const decoder = new TextDecoder();
	terminal = new Bun.Terminal({
		cols: 120,
		rows: 55,
		data(_terminal, bytes) {
			output += decoder.decode(bytes, { stream: true });
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
				COLORFGBG: mode === "arabic" ? "15;0" : "0;15",
			}),
		},
	);
	setupFinishedAt = Date.now();
	enterStage("startup: authenticated initial frame");
	await wait(
		() =>
			wires.some((wire) => wire.path === "/api/v1/me" && wire.status === 200) &&
			frames() > 1,
		"Startup did not finish",
	);
	await send("navigation: open workspace", "\x1b[B\r", () =>
		frame().includes("Terminal list"),
	);
	await send("navigation: open task list", "\r", () => frame().includes(title));
	const parentSelected = () =>
		frame()
			.split("\n")
			.some((line) => {
				const row = line.replace(/^[\s│|]+|[\s│|]+$/g, "");
				return (
					/^>\s+(?:○|\( \)|\[ \])\s+/.test(row) &&
					new RegExp(`^${title}(?:\\s{2,}|$)`).test(
						row.replace(/^>\s+(?:○|\( \)|\[ \])\s+/, ""),
					)
				);
			});
	if (mode === "delete-cascade") {
		assert.ok(childTask < task);
		await send("selection: select parent task", "\x1b[B", parentSelected);
	}
	assert.ok(parentSelected(), "The parent task must be selected");
	const deleting = mode.startsWith("delete");
	await send(
		deleting
			? "observation: open deletion form"
			: "observation: open edit form",
		deleting ? "d" : "e",
		() =>
			frame().includes(deleting ? "childrenState" : `"${title}"`) ||
			(deleting && frame().includes('"count"')),
	);
	if (deleting) {
		assert.ok(
			wires.some(
				(wire) =>
					wire.path === `/api/v1/tasks/${task}/deletion-observation` &&
					wire.status === 200,
			),
			"The selected parent deletion observation must succeed",
		);
		if (mode === "delete-cascade") {
			assert.ok(frame().includes('{"version":1,"count":1,'));
			await send("deletion: select children policy", "1");
			await send("deletion: confirm children policy", "\r");
			assert.equal(frame().includes(notSent), false);
		}
		await send(
			"deletion: prepare frozen request",
			mode === "delete-cascade" ? "2\r" : "1\r",
			() => frame().includes(notSent),
		);
	} else {
		await send(
			"update: fill patch and prepare frozen request",
			"!\r\x1b[200~\nthird\x1b[201~\r2026-10-05T09:30:00.000Z\r1\r\x7f2\r",
			() => frame().includes(notSent),
		);
	}
	await send("review: inspect frozen request", "v", () =>
		frame().includes("requestId"),
	);
	assert.equal(writes().length, 0);
	assert.equal(await receipts(), 0);
	await send("review: pasted approval must not send", "\x1b[200~y\n\x1b[201~");
	assert.equal(writes().length, 0);
	if (mode === "conflict")
		await admin.query("update task set title='Concurrent edit' where id=$1", [
			task,
		]);
	if (mode === "revoked")
		await revokePersonalAccessToken(runtime, actor, pat.id);
	await send(
		"approval: send and observe outcome",
		"y",
		() =>
			writes().length === 1 &&
			wires.at(-1)?.status !== 0 &&
			(["conflict", "revoked", "read"].includes(mode)
				? frame().includes(
						mode === "conflict"
							? "request_conflict"
							: mode === "revoked"
								? "unauthorized"
								: "forbidden",
					) &&
					!frame().includes(notSent) &&
					!frame().includes(unconfirmed)
				: frame().includes(unconfirmed) ||
					(!frame().includes(notSent) && !frame().includes(unconfirmed))),
	);
	const first = writes()[0];
	assert.equal(first.method, deleting ? "DELETE" : "PATCH");
	assert.ok(first.key && /^[0-9a-f-]{36}$/.test(first.key));
	const body = JSON.parse(first.body);
	assert.equal(body.listId, list);
	assert.match(body.expectedState, /^[0-9a-f]{64}$/);
	if (deleting) assert.equal(body.cascadeChildren, mode === "delete-cascade");
	else
		assert.deepEqual(body.patch, {
			title: `${title}!`,
			notes: "first\nsecond\nthird",
			dueAt: "2026-10-05T09:30:00.000Z",
			dueAllDay: true,
			priority: 2,
		});
	if (["conflict", "revoked", "read"].includes(mode)) {
		assert.equal(
			first.status,
			mode === "conflict" ? 409 : mode === "revoked" ? 401 : 403,
		);
		assert.equal(await receipts(), 0);
		assert.equal(
			(await rows())[0].title,
			mode === "conflict" ? "Concurrent edit" : title,
		);
		assert.equal(frame().includes(notSent), false);
		assert.equal(frame().includes(unconfirmed), false);
		if (mode !== "conflict") assert.equal(frame().includes(title), false);
	} else {
		assert.equal(first.status, 200);
		assert.equal(await receipts(), 1);
		if (deleting) {
			assert.equal((await rows()).length, 0);
			assert.equal(
				(
					await admin.query(
						"select count(*)::int count from comment where task_id=$1",
						[childTask],
					)
				).rows[0].count,
				0,
			);
		} else {
			const row = (await rows())[0];
			assert.deepEqual(
				{ ...row, due_at: row.due_at.toISOString() },
				{
					title: `${title}!`,
					notes: "first\nsecond\nthird",
					due_at: "2026-10-05T09:30:00.000Z",
					due_all_day: true,
					priority: 2,
				},
			);
		}
		if (mode === "delete-retry")
			await admin.query(
				"insert into task(id,list_id,title,sort_key) values($1,$2,'Recreated task','a0')",
				[task, list],
			);
		if (["update-retry", "delete-retry"].includes(mode)) {
			await send(
				"replay: observe immutable retry",
				"r",
				() =>
					writes().length === 2 &&
					writes()[1].status !== 0 &&
					!frame().includes(notSent) &&
					!frame().includes(unconfirmed),
			);
			assert.deepEqual(writes()[1], first);
			assert.equal(await receipts(), 1);
			assert.equal(
				wires.filter(
					(wire) =>
						wire.path.endsWith("/observation") ||
						wire.path.endsWith("/deletion-observation"),
				).length,
				1,
			);
			if (mode === "delete-retry")
				assert.equal((await rows())[0].title, "Recreated task");
		}
	}
	if (mode === "arabic") {
		enterStage("resize: Arabic frame");
		const beforeArabic = frames();
		terminal.resize(40, 20);
		child.kill("SIGWINCH");
		await wait(
			() => frames() > beforeArabic && /[\u0600-\u06ff]/.test(frame()),
			"Arabic frame was absent",
		);
		enterStage("resize: tiny safety frame");
		const beforeTiny = frames();
		terminal.resize(19, 8);
		child.kill("SIGWINCH");
		await wait(
			() =>
				frames() > beforeTiny &&
				// The preceding 40-column frame also has these keys in its footer.
				// Only the tiny viewport starts with the compact safety-key row.
				frame().startsWith("Esc | q") &&
				/\bq\b/.test(frame()) &&
				/\bEsc\b/.test(frame()),
			"Narrow terminal safety keys were absent",
		);
		assert.ok(frame().split(/\r?\n/).length <= 8);
		assert.ok(
			frame()
				.split(/\r?\n/)
				.every((line) => line.length <= 18),
		);
	}
	await send(
		"exit: restore terminal and quit",
		mode === "update-uncertain" ? "\x03" : "q",
		() => child?.exitCode !== null,
	);
	assert.equal(await child.exited, mode === "update-uncertain" ? 130 : 0);
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
	if (mode === "update-uncertain") {
		const line = output
			.split(/[\r\n]+/)
			.find((line) => line.includes('{"requestId":'));
		assert.ok(line, "Exact retry record was absent");
		const record = JSON.parse(line.slice(line.indexOf('{"requestId":')));
		assert.deepEqual(record, {
			requestId: first.key,
			endpoint: first.path,
			method: "PATCH",
			body,
		});
	}
	passed = true;
} catch (error) {
	try {
		process.stderr.write(
			`${JSON.stringify({ terminalFailure: failureDiagnostic() })}\n`,
		);
	} catch {
		// Diagnostics must not replace the original failure.
	}
	throw error;
} finally {
	clearTimeout(timeout);
	if (child && child.exitCode === null) {
		child.kill("SIGKILL");
		await child.exited;
	}
	terminal?.close();
	await server?.stop(true);
	await runtime.end();
	await admin.query("delete from task where list_id=$1", [list]);
	await admin.query("delete from list where id=$1", [list]);
	await admin.query("delete from membership where workspace_id=$1", [
		workspace,
	]);
	await admin.query("delete from workspace where id=$1", [workspace]);
	await admin.query('delete from "user" where id=$1', [actor]);
	if (roleCreated) {
		await admin.query(`drop owned by "${role}"`);
		await admin.query(`drop role "${role}"`);
	}
	assert.equal(
		(
			await admin.query(
				"select count(*)::int count from pg_roles where rolname=$1",
				[role],
			)
		).rows[0].count,
		0,
	);
	assert.equal(
		(
			await admin.query(
				"select count(*)::int count from pg_stat_activity where usename=$1",
				[role],
			)
		).rows[0].count,
		0,
	);
	assert.equal(
		(
			await admin.query(
				"select count(*)::int count from public_api_request where user_id=$1",
				[actor],
			)
		).rows[0].count,
		0,
	);
	await admin.end();
}
assert.ok(passed);
process.stdout.write(
	JSON.stringify({
		mode,
		passed,
		requests: wires.length,
		writes: writes().length,
		cleanup: true,
		directLogin: true,
	}),
);
