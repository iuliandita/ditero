import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";

const mode = process.argv[2];
const privateFile = process.env.TUI_TEST_ENV_FILE;
if (privateFile) {
	for (const line of readFileSync(privateFile, "utf8").split("\n")) {
		const match = /^([A-Z_]+)=(.*)$/.exec(line);
		if (match) process.env[match[1]] = match[2];
	}
}
const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("A designated fixture database is required");
const privateSubprocessEnv = (extra: Record<string, string> = {}) => ({
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
const role = `tui_pty_${suffix}`;
const actor = `tui-actor-${suffix}`;
const workspace = `tui-workspace-${suffix}`;
const list = `tui-list-${suffix}`;
const recurring = `tui-recurring-${suffix}`;
const observedDue = "2026-10-04T12:00:00.000Z";
const protectedTitle = "Protected recurring fixture";
const runtime = new Pool({
	connectionString: databaseURL,
	connectionTimeoutMillis: 1000,
	statement_timeout: 5000,
});
runtime.on("connect", (client) => {
	void client.query(`set role "${role}"`);
});
let server: ReturnType<typeof Bun.serve> | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let terminal: Bun.Terminal | undefined;
let roleCreated = false;
const timeout = setTimeout(() => child?.kill("SIGKILL"), 13000);
let output = "";
let serverTime = "";
let calls = 0;
const writes: { key: string | null; body: string; endpoint: string }[] = [];
const writeStatuses: number[] = [];
const deadline = Date.now() + 12000;
const waitFor = async (predicate: () => boolean, message: string) => {
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
};
const text = (value: string) => output.includes(value);
const latestFrame = () =>
	(output.split("\x1b[H\x1b[2J").at(-1) ?? "").replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
		"",
	);
const send = async (value: string, expected?: string) => {
	terminal?.write(value);
	if (expected)
		await waitFor(() => text(expected), "Expected terminal frame was absent");
};
const counts = async () =>
	(
		await admin.query(
			`select (select count(*)::int from task where list_id=$1 and id<>$2) tasks,
	(select count(*)::int from task_completion_event where task_id=$2) history,
	(select count(*)::int from karma_event where user_id=$3) karma,
	(select count(*)::int from public_api_request where user_id=$3) receipts`,
			[list, recurring, actor],
		)
	).rows[0];
try {
	if (privateFile) {
		const migration = Bun.spawn(
			[process.execPath, "run", "src/db/migrate.ts"],
			{
				env: privateSubprocessEnv({ DATABASE_URL: databaseURL }),
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		assert.equal(await migration.exited, 0, "Fixture migration failed");
	}
	await admin.query(
		`create role "${role}" nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	assert.deepEqual(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows[0],
		{ rolsuper: false, rolbypassrls: false },
	);
	await admin.query(
		'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
		[actor, "Fixture actor", `${suffix}@tui.test`],
	);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Fixture workspace',$2,'shared')",
		[workspace, actor],
	);
	await admin.query(
		"insert into membership(id,user_id,workspace_id,role) values($1,$2,$3,'owner')",
		[`membership-${suffix}`, actor, workspace],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,sort_key) values($1,$2,$3,'Fixture list','a0')",
		[list, workspace, actor],
	);
	await admin.query(
		"insert into user_pref(id,timezone,timezone_chosen,locale) values($1,'Europe/Berlin',true,$2)",
		[actor, mode === "arabic" ? "ar" : "en"],
	);
	await admin.query(
		"insert into task(id,list_id,title,sort_key,due_at,rrule) values($1,$2,$3,'a0',$4,'FREQ=DAILY')",
		[recurring, list, protectedTitle, observedDue],
	);
	const pat = await createPersonalAccessToken(runtime, actor, {
		name: "Fixture terminal",
		access: mode === "read" ? "read" : "write",
	});
	const app = publicApiRoutes(runtime, async () => true);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			calls++;
			const endpoint = new URL(request.url).pathname;
			if (request.method === "POST")
				writes.push({
					key: request.headers.get("idempotency-key"),
					body: await request.clone().text(),
					endpoint,
				});
			const response = await app.handle(request);
			if (request.method === "POST") writeStatuses.push(response.status);
			if (endpoint === "/api/v1/me" && response.ok)
				serverTime = (await response.clone().json()).data.serverTime;
			// Corrupt the first committed completion response at the transport boundary.
			if (
				(mode === "retry" || mode === "uncertain") &&
				request.method === "POST" &&
				writes.length === 1 &&
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
	const env = privateSubprocessEnv({
		DITERO_URL: `http://127.0.0.1:${server.port}`,
		DITERO_TOKEN: pat.token,
		TERM: "xterm-256color",
		COLORFGBG: mode === "arabic" ? "15;0" : "0;15",
	});
	const command = process.env.TUI_TEST_COMMAND
		? (JSON.parse(process.env.TUI_TEST_COMMAND) as string[])
		: [process.execPath, "run", "src/tui/index.ts", "--allow-loopback-http"];
	if (mode === "notty") {
		const piped = Bun.spawn(command, {
			env,
			cwd: process.env.TUI_TEST_CWD,
			stdout: "pipe",
			stderr: "pipe",
		});
		child = piped;
		assert.equal(await piped.exited, 2);
		assert.equal(calls, 0);
		assert.equal(
			(await new Response(piped.stdout).text()).includes("\x1b"),
			false,
		);
	} else {
		terminal = new Bun.Terminal({
			cols: 120,
			rows: 45,
			data(_terminal, bytes) {
				output += new TextDecoder().decode(bytes);
			},
		});
		const flags = [
			terminal.inputFlags,
			terminal.outputFlags,
			terminal.localFlags,
			terminal.controlFlags,
		];
		child = Bun.spawn(command, {
			env,
			terminal,
			cwd: process.env.TUI_TEST_CWD,
		});
		await waitFor(
			() => text(mode === "arabic" ? "Ditero" : "Ready") && !!serverTime,
			"Terminal startup did not finish",
		);
		await Bun.sleep(20);
		await send("\x1b[B\r", "Fixture list");
		if (mode === "create") {
			await send("n", "Task title");
			await send("Coffee fixture\rtomorrow\r");
			{
				await waitFor(
					() => latestFrame().includes("NOT SENT"),
					"Creation review was absent",
				);
				await send("v");
				await waitFor(
					() => latestFrame().includes("requestId"),
					"Exact creation payload was absent",
				);
				assert.equal(writes.length, 0);
				assert.equal((await counts()).tasks, 0);
				await send("\x1b[200~y\n\x1b[201~");
				await Bun.sleep(30);
				assert.equal(writes.length, 0);
				await send("y");
				await waitFor(
					() => writes.length === 1 && latestFrame().includes("Fixture list"),
					"Confirmed creation did not refresh",
				);
				const created = (
					await admin.query(
						"select title,due_at,due_all_day from task where list_id=$1 and id<>$2",
						[list, recurring],
					)
				).rows;
				assert.equal(created.length, 1);
				assert.equal(created[0].title, "Coffee fixture");
				assert.equal(created[0].due_all_day, true);
				const today = new Intl.DateTimeFormat("en-CA", {
					timeZone: "Europe/Berlin",
					year: "numeric",
					month: "2-digit",
					day: "2-digit",
				}).format(new Date(serverTime));
				const tomorrow = new Date(`${today}T12:00:00Z`);
				tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
				assert.equal(
					new Intl.DateTimeFormat("en-CA", {
						timeZone: "Europe/Berlin",
						year: "numeric",
						month: "2-digit",
						day: "2-digit",
					}).format(created[0].due_at),
					tomorrow.toISOString().slice(0, 10),
				);
				assert.equal(
					new Intl.DateTimeFormat("en-GB", {
						timeZone: "Europe/Berlin",
						hour: "2-digit",
						minute: "2-digit",
						hourCycle: "h23",
					}).format(created[0].due_at),
					"12:00",
				);
				assert.equal((await counts()).receipts, 1);
				await send("q");
			}
		} else {
			await send("\r", protectedTitle);
			if (mode === "read") {
				await send("c", "NOT SENT");
				await send("v");
				await waitFor(
					() => latestFrame().includes("requestId"),
					"Exact completion payload was absent",
				);
				await send("y");
				await waitFor(
					() => latestFrame().includes("forbidden"),
					"Read token completion was not refused",
				);
				assert.equal(latestFrame().includes(protectedTitle), false);
				assert.deepEqual(writeStatuses, [403]);
				assert.deepEqual(await counts(), {
					tasks: 0,
					history: 0,
					karma: 0,
					receipts: 0,
				});
				await send("q");
			} else if (mode === "revoked") {
				await revokePersonalAccessToken(runtime, actor, pat.id);
				await send("r");
				await waitFor(
					() => latestFrame().includes("unauthorized"),
					"Revocation was not observed",
				);
				assert.equal(latestFrame().includes(protectedTitle), false);
				await send("q");
			} else if (mode === "arabic") {
				const beforeArabic = output.split("\x1b[H\x1b[2J").length;
				terminal.resize(40, 20);
				child.kill("SIGWINCH");
				await waitFor(
					() =>
						output.split("\x1b[H\x1b[2J").length > beforeArabic &&
						/[\u0600-\u06ff]/.test(latestFrame()),
					"Arabic supported-size frame was absent",
				);
				const beforeTiny = output.split("\x1b[H\x1b[2J").length;
				terminal.resize(19, 8);
				child.kill("SIGWINCH");
				await waitFor(
					() =>
						output.split("\x1b[H\x1b[2J").length > beforeTiny &&
						/\bq\b/.test(latestFrame()) &&
						/\bEsc\b/.test(latestFrame()),
					"Narrow terminal safety keys were absent",
				);
				assert.ok(latestFrame().split(/\r?\n/).length <= 8);
				assert.ok(
					latestFrame()
						.split(/\r?\n/)
						.every((line) => line.length <= 18),
				);
				await send("\x03");
			} else {
				await send("c", "NOT SENT");
				await send("v");
				await waitFor(
					() => latestFrame().includes("requestId"),
					"Exact completion payload was absent",
				);
				await send("y");
				await waitFor(
					() =>
						writeStatuses.length === 1 && latestFrame().includes("UNCONFIRMED"),
					"Lost committed response was not observed",
				);
				assert.deepEqual(await counts(), {
					tasks: 0,
					history: 1,
					karma: 1,
					receipts: 1,
				});
				assert.notEqual(
					(
						await admin.query("select due_at from task where id=$1", [
							recurring,
						])
					).rows[0].due_at.toISOString(),
					observedDue,
				);
				if (mode === "retry") {
					await send("r");
					await waitFor(
						() =>
							writes.length === 2 &&
							latestFrame().includes(protectedTitle) &&
							!latestFrame().includes("NOT SENT") &&
							!latestFrame().includes("UNCONFIRMED") &&
							writeStatuses.length === 2,
						"Completion replay did not refresh",
					);
					assert.deepEqual(writes[1], writes[0]);
					assert.deepEqual(await counts(), {
						tasks: 0,
						history: 1,
						karma: 1,
						receipts: 1,
					});
					await send("q");
				} else await send("\x03");
			}
		}
		assert.equal(
			await child.exited,
			["uncertain", "arabic"].includes(mode ?? "") ? 130 : 0,
			`Exit evidence: terminalCleaned=${output.includes("\x1b[?1049l")}, writes=${writes.length}`,
		);
		await Bun.sleep(20);
		if (mode === "uncertain") {
			const recordLine = output
				.split(/[\r\n]+/)
				.find((line) => line.includes('{"requestId":'));
			assert.ok(recordLine);
			const record = recordLine.slice(recordLine.indexOf('{"requestId":'));
			const retry = JSON.parse(record);
			assert.equal(retry.requestId, writes[0].key);
			assert.equal(retry.endpoint, writes[0].endpoint);
			assert.deepEqual(retry.body, JSON.parse(writes[0].body));
		}
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
		if (process.env.TUI_TEST_COMMAND)
			assert.equal(output.includes("INNER_TERMINAL_RESTORED"), true);
	}
	process.stdout.write(
		JSON.stringify({
			mode,
			passed: true,
			requests: calls,
			writes: writes.length,
		}),
	);
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
	await admin.end();
}
