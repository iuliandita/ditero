import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Pool } from "pg";
import {
	parseApiTaskPlacement,
	placementSortKeySchema,
} from "../../src/domain/public-api-task-placement.ts";
import { keyBetween } from "../../src/domain/sort-key.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";
import { visibleCells } from "../../src/tui/render.ts";

const modes = [
	"move",
	"subtask",
	"cancel-help-paste",
	"stale-self",
	"sibling-race",
	"retry",
	"uncertain-exit",
	"revoked",
	"read",
	"tie",
	"malformed",
	"arabic",
];
const mode = process.argv[2] ?? "";
assert.ok(modes.includes(mode), "Unknown terminal fixture case");
// Read from the real process environment, before any env file and before a Pool.
assert.equal(process.env.NODE_ENV, "test", "The fixture runs only under test");
assert.equal(
	process.env.DITERO_TUI_ORDERING_FIXTURE,
	"1",
	"The ordering fixture operation marker is required",
);
// Optional actual-PTY capture; absent means the default qualification is unchanged.
const captureDir = process.env.TUI_ORDERING_CAPTURE_DIR || undefined;
const captureStyle = process.env.TUI_ORDERING_CAPTURE_STYLE;
assert.ok(
	captureStyle === undefined ||
		captureStyle === "color" ||
		captureStyle === "plain",
	"The capture style must be absent, color, or plain",
);
if (captureDir) {
	assert.ok(isAbsolute(captureDir), "The capture directory must be absolute");
	assert.ok(
		statSync(captureDir).isDirectory(),
		"The capture directory must exist",
	);
} else {
	assert.equal(captureStyle, undefined, "A capture style needs a directory");
}
const style = captureStyle ?? "color";
const maxCaptureBytes = 256 * 1024;
if (process.env.TUI_ORDERING_ENV_FILE) {
	for (const line of readFileSync(
		process.env.TUI_ORDERING_ENV_FILE,
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
const role = `tui_ordering_${suffix}`;
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
const arabic = mode === "arabic";
const english = !arabic;
const notSent = arabic ? "لم يُرسل" : "NOT SENT";
const unconfirmed = arabic ? "غير مؤكد" : "UNCONFIRMED";

// Every row is synthetic; keys come from the same generator the client uses.
interface Seed {
	id: string;
	title: string;
	parent: string | null;
	key: string;
	done: boolean;
}
const seed: Seed[] = [];
const sequence = (count: number) => {
	const out: string[] = [];
	let previous: string | null = null;
	for (let index = 0; index < count; index++) {
		previous = keyBetween(previous, null);
		out.push(previous);
	}
	return out;
};
let target: Seed;
let targetChildren: Seed[] = [];
if (mode === "move") {
	// More than one 100-row page, done rows included, manual order unrelated to IDs.
	const count = 105;
	const ids = Array.from({ length: count }, () => randomUUID()).sort();
	const order = Array.from(
		{ length: count },
		(_, index) => ids[(index * 37 + 1) % count],
	);
	assert.equal(new Set(order).size, count);
	const keys = sequence(count);
	order.forEach((id, index) => {
		seed.push({
			id,
			title:
				id === ids[0]
					? "Target task"
					: `Task ${String(index).padStart(3, "0")}`,
			parent: null,
			key: keys[index],
			done: index % 4 === 0,
		});
	});
	target = seed.find((row) => row.id === ids[0]) as Seed;
	targetChildren = [1, 2].map((number) => ({
		id: randomUUID(),
		title: `Target child ${number}`,
		parent: target.id,
		key: sequence(2)[number - 1],
		done: false,
	}));
} else if (mode === "subtask") {
	const roots = sequence(4);
	const root = (title: string, index: number): Seed => ({
		id: randomUUID(),
		title,
		parent: null,
		key: roots[index],
		done: false,
	});
	const [first, parent, second, decoy] = [
		root("Root A", 0),
		root("Parent task", 1),
		root("Root B", 2),
		root("Decoy parent", 3),
	];
	seed.push(first, parent, second, decoy);
	const kids = sequence(3);
	const children = ["Child 1", "Child 2", "Child 3"].map(
		(title, index): Seed => ({
			id: randomUUID(),
			title,
			parent: parent.id,
			key: kids[index],
			done: index === 1,
		}),
	);
	targetChildren = [];
	seed.push(
		...children,
		...["Decoy 1", "Decoy 2"].map(
			(title, index): Seed => ({
				id: randomUUID(),
				title,
				parent: decoy.id,
				key: kids[index],
				done: false,
			}),
		),
	);
	target = children[2];
} else {
	const keys = sequence(4);
	const titles = ["Alpha", "Beta", "Gamma", "Delta"];
	titles.forEach((title, index) => {
		seed.push({
			id: randomUUID(),
			title,
			parent: null,
			key: keys[index],
			done: title === "Beta",
		});
	});
	if (mode === "tie") seed[1].key = seed[0].key;
	if (mode === "malformed") seed[3].key = "a";
	target = seed[2];
}
seed.push(...targetChildren);
const group = seed
	.filter((row) => row.parent === target.parent)
	.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
const from = group.findIndex((row) => row.id === target.id) + 1;
const to = from === 1 ? 2 : 1;
const others = group.filter((row) => row.id !== target.id);
const prev = others[to - 2] ?? null;
const next = others[to - 1] ?? null;
// The review key is jittered by the client, so it is captured from the actual
// review rather than predicted; it stays empty until then.
let proposed = "";
const total = group.length;
const parentTitle = seed.find((row) => row.id === target.parent)?.title;
const raced = mode === "sibling-race" ? others[others.length - 1] : undefined;
// Derived from the captured key, immediately before the concurrent write.
let raceKey = "";
// A subtask's root peers and a sibling parent's children must stay untouched.
const expectedRows = (final: boolean) => {
	const rows = new Map(
		seed.map((row) => [row.id, { parent: row.parent, key: row.key }]),
	);
	if (final) {
		const moved = rows.get(target.id);
		assert.ok(moved);
		moved.key = proposed;
		if (raced) {
			const peer = rows.get(raced.id);
			assert.ok(peer);
			peer.key = raceKey;
		}
	}
	return rows;
};

let roleCreated = false;
let secret = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let terminal: Bun.Terminal | undefined;
let child: ReturnType<typeof Bun.spawn> | undefined;
let output = "";
const wires: {
	method: string;
	path: string;
	query: string;
	key: string | null;
	body: string;
	status: number;
	ids?: string[];
}[] = [];
// The explicit >100 row case needs two real pages plus observations.
const long = mode === "move";
const deadline = Date.now() + (long ? 29000 : 13000);
const timeout = setTimeout(() => child?.kill("SIGKILL"), long ? 30000 : 14000);
const clear = "\x1b[H\x1b[2J";
const frame = () =>
	(output.split(clear).at(-1) ?? "").replace(
		new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"),
		"",
	);
const frames = () => output.split(clear).length;
// The actual bytes of the current frame, SGR included, never redrawn.
const rawFrame = () => output.split(clear).at(-1) ?? "";
let size = { columns: 120, rows: 55 };
const captured = new Map<
	string,
	{ raw: string; columns: number; rows: number }
>();
const sgrPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
// Why a frame is not yet the complete frame of the requested geometry, or
// undefined when it is. The renderer paints exactly `rows` lines and the session
// joins them with CRLF; the tty turns that into CR CR LF, so only a run of CRs
// before LF is a line break and any other CR is a defect, never a break. Widths
// use the renderer's own cell counting over the text left after the SGR runs.
const frameProblem = (raw: string, columns: number, rows: number) => {
	if (raw.length === 0) return "the frame is empty";
	const lines = raw.replace(/\r+\n/g, "\n").split("\n");
	const plain = lines.map((line) => line.replace(sgrPattern, ""));
	if (plain.some((line) => line.includes(String.fromCharCode(27))))
		return "an escape sequence is incomplete";
	if (plain.some((line) => line.includes("\r")))
		return "a carriage return is not part of a line break";
	if (raw.match(sgrPattern)?.at(-1)?.endsWith("[0m") === false)
		return "the last style run is not reset";
	if (lines.length !== rows)
		return `the frame has ${lines.length} rows, not ${rows}`;
	const widest = Math.max(...plain.map(visibleCells));
	if (widest > columns)
		return `the frame is ${widest} columns wide, over ${columns}`;
	return undefined;
};
// Waits for a new, complete frame of exactly the requested geometry that has
// stopped growing, so a delayed frame at another size or a prefix of a frame
// that is still arriving is never taken for it. Bounded by the shared deadline.
const awaitFrame = async (
	columns: number,
	rows: number,
	ready: () => boolean,
	message: string,
	before = 0,
) => {
	let seen = -1;
	try {
		await wait(() => {
			const quiet = output.length === seen;
			seen = output.length;
			return (
				frames() > before &&
				quiet &&
				frameProblem(rawFrame(), columns, rows) === undefined &&
				ready()
			);
		}, message);
	} catch (error) {
		const problem = frameProblem(rawFrame(), columns, rows);
		throw new Error(
			`${message}${problem ? `: ${problem}` : ""}`,
			error instanceof Error ? { cause: error } : undefined,
		);
	}
};
// Only actual phase frames; the first capture of a phase wins.
const capture = (phase: string) => {
	if (!captureDir || captured.has(phase)) return;
	const raw = rawFrame();
	assert.ok(raw.length > 0, `The ${phase} frame was empty`);
	assert.ok(
		Buffer.byteLength(raw) <= maxCaptureBytes,
		`The ${phase} frame exceeds the capture bound`,
	);
	const problem = frameProblem(raw, size.columns, size.rows);
	assert.ok(
		problem === undefined,
		`The ${phase} frame is not a complete ${size.columns}x${size.rows} frame: ${problem}`,
	);
	captured.set(phase, { raw, ...size });
};
const resizeTo = async (
	columns: number,
	rows: number,
	ready: () => boolean,
	message: string,
) => {
	const before = frames();
	size = { columns, rows };
	terminal?.resize(columns, rows);
	child?.kill("SIGWINCH");
	await awaitFrame(columns, rows, ready, message, before);
};
// A frame captured at the current size must first be complete at that size.
const settle = (phase: string) =>
	awaitFrame(
		size.columns,
		size.rows,
		() => true,
		`The ${phase} frame did not complete`,
	);
const writes = () => wires.filter((wire) => wire.method === "PATCH");
const taskReads = () =>
	wires.filter(
		(wire) => wire.method === "GET" && wire.path === "/api/v1/tasks",
	);
const placementReads = () =>
	wires.filter(
		(wire) =>
			wire.method === "GET" &&
			wire.path === `/api/v1/tasks/${target.id}/placement-observation`,
	);
const listReads = () =>
	wires.filter(
		(wire) =>
			wire.method === "GET" &&
			wire.path === `/api/v1/lists/${list}/observation`,
	);
const wait = async (predicate: () => boolean, message: string) => {
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(message);
		await Bun.sleep(5);
	}
};
const send = async (keys: string, predicate?: () => boolean) => {
	const previous = frames();
	terminal?.write(keys);
	await wait(
		predicate ?? (() => frames() > previous),
		`Expected terminal transition was absent after ${JSON.stringify(keys)}`,
	);
};
const rowText = (line: string) => line.replace(/^[\s│|]+|[\s│|]+$/g, "");
const escapePattern = (value: string) =>
	value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const browseGlyph = /^>\s+(?:○|●|\( \)|\(x\)|\[ \]|\[x\])\s+/;
const selectedTitle = () => {
	for (const line of frame().split("\n")) {
		const row = rowText(line);
		if (browseGlyph.test(row))
			return row.replace(browseGlyph, "").replace(/\s{2,}.*$/, "");
	}
	return null;
};
// Order rows read "> 3. ○ Title", unlike browse rows, so they cannot be confused.
const orderSelected = (title: string) =>
	frame()
		.split("\n")
		.some((line) =>
			new RegExp(
				`^>\\s+\\S+\\.\\s+(?:○|●|\\( \\)|\\(x\\))\\s+${escapePattern(title)}\\s*$`,
			).test(rowText(line)),
		);
const emptyPrompt = () =>
	frame()
		.split("\n")
		.some((line) => rowText(line) === ">");
const promptText = `Type a position from 1 to ${total}`;
// At 40x20 the position field must lead the order frame: above every sibling
// row and within the first rows, with the English prompt above it.
const assertNarrowOrderField = (echo: RegExp, label: string) => {
	const rows = frame().split("\n").map(rowText);
	const field = rows.findIndex((row) => echo.test(row));
	const sibling = rows.findIndex((row) =>
		/^>?\s*\d+\.\s+(?:○|●|\( \)|\(x\))\s/.test(row),
	);
	assert.ok(field >= 0, `${label} was absent`);
	assert.ok(field < 8, `${label} is not in the first rows`);
	assert.ok(sibling < 0 || field < sibling, `${label} is below a sibling row`);
	if (english) {
		const prompt = rows.findIndex((row) => row.includes(promptText));
		assert.ok(prompt >= 0 && prompt < field, `${label} lacks its prompt above`);
	}
};
// Reads the exact payload view of the current review: one consistent key and
// request ID, a valid placement key, and strictly between its anchors.
const captureReview = () => {
	const text = frame();
	const unique = (pattern: RegExp, label: string) => {
		const found = new Set([...text.matchAll(pattern)].map((match) => match[1]));
		assert.equal(found.size, 1, `Exactly one ${label} must be shown`);
		return [...found][0];
	};
	const key = unique(/"sortKey"\s*:\s*"([A-Za-z0-9]+)"/g, "sortKey");
	const requestId = unique(
		/"requestId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/g,
		"requestId",
	);
	assert.ok(
		placementSortKeySchema.safeParse(key).success,
		"The reviewed key must be a valid placement key",
	);
	if (prev) assert.ok(key > prev.key, "The key must sort after its anchor");
	if (next) assert.ok(key < next.key, "The key must sort before its anchor");
	return { key, requestId };
};
const squash = (text: string) =>
	text.split("\n").map(rowText).join(" ").replace(/\s+/g, " ");
const compactAck = arabic
	? "قُبل؛ الموضع غير مضمون."
	: "Accepted; rank not guaranteed.";
const arabicAck = (() => {
	if (!arabic) return [];
	const messages = JSON.parse(
		readFileSync(new URL("../../messages/ar.json", import.meta.url), "utf8"),
	) as Record<string, unknown>;
	const template = messages.tui_order_acknowledged;
	assert.equal(
		typeof template,
		"string",
		"The Arabic acknowledgement must exist",
	);
	return squash(
		(template as string)
			.replace("{position}", new Intl.NumberFormat("ar").format(to))
			.replace("{total}", new Intl.NumberFormat("ar").format(total)),
	)
		.split(/(?<=\.)\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
})();
// A fresh read selects its first row, and browse rows are in ID order. Each Down
// waits for the frame that shows the next row, never for any frame, so a loading,
// stale or partly written frame cannot be mistaken for the selection.
const selectTitle = async (title: string) => {
	await wait(
		() => taskReads().at(-1)?.ids !== undefined,
		"The browse read was absent",
	);
	const titles = (taskReads().at(-1)?.ids ?? []).map(
		(id) => seed.find((row) => row.id === id)?.title,
	);
	const goal = titles.indexOf(title);
	assert.ok(goal >= 0, "The designated task must be in the browse read");
	await wait(
		() => selectedTitle() === titles[0],
		"The first browse row was not selected",
	);
	for (let step = 1; step <= goal; step++)
		await send("\x1b[B", () => selectedTitle() === titles[step]);
	assert.equal(selectedTitle(), title, "The designated task must be selected");
};
const taskRows = async () =>
	new Map(
		(
			await admin.query(
				"select id,parent_id,sort_key from task where list_id=$1",
				[list],
			)
		).rows.map((row) => [
			row.id as string,
			{ parent: row.parent_id as string | null, key: row.sort_key as string },
		]),
	);
const receipts = async () =>
	(
		await admin.query(
			"select count(*)::int count from public_api_request where user_id=$1",
			[actor],
		)
	).rows[0].count as number;
const assertRows = async (final: boolean, label: string) =>
	assert.deepEqual(
		[...(await taskRows())].sort(),
		[...expectedRows(final)].sort(),
		label,
	);
const redact = (text: string) =>
	secret ? text.replaceAll(secret, "[redacted]") : text;
const cleanupFailures: string[] = [];
const cleanup = async (
	label: string,
	run: () => Promise<unknown> | unknown,
) => {
	try {
		await run();
	} catch (error) {
		const message = `${label}: ${error instanceof Error ? error.message : String(error)}`;
		cleanupFailures.push(message);
		process.stderr.write(`cleanup failed: ${redact(message)}\n`);
	}
};

let passed = false;
let frameLines: string[] = [];
const patches: { status: number; key: string | null }[] = [];
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
		[actor, arabic ? "ar" : "en"],
	);
	// Parents first so a child never precedes the row it references.
	for (const row of [...seed].sort(
		(a, b) => Number(a.parent !== null) - Number(b.parent !== null),
	))
		await admin.query(
			"insert into task(id,list_id,title,parent_id,sort_key,done,completed_at) values($1,$2,$3,$4,$5,$6,case when $6 then now() else null end)",
			[row.id, list, row.title, row.parent, row.key, row.done],
		);
	const pat = await createPersonalAccessToken(runtime, actor, {
		name: "Terminal ordering fixture",
		access: mode === "read" ? "read" : "write",
	});
	secret = pat.token;
	const app = publicApiRoutes(runtime, async () => true);
	const dropFirstResponse = ["retry", "uncertain-exit"].includes(mode);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const wire: (typeof wires)[number] = {
				method: request.method,
				path: url.pathname,
				query: url.search,
				key: request.headers.get("idempotency-key"),
				body: await request.clone().text(),
				status: 0,
			};
			wires.push(wire);
			const response = await app.handle(request);
			wire.status = response.status;
			if (wire.method === "GET" && wire.path === "/api/v1/tasks") {
				const parsed = JSON.parse(await response.clone().text());
				wire.ids = (parsed.data as { id: string }[]).map((row) => row.id);
			}
			if (
				dropFirstResponse &&
				writes().length === 1 &&
				request.method === "PATCH" &&
				response.ok
			) {
				// The write committed; only its response is lost.
				await response.arrayBuffer();
				return new Response("{", {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			return response;
		},
	});
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
		[
			process.execPath,
			"--no-env-file",
			"run",
			"src/tui/index.ts",
			"--allow-loopback-http",
			...(captureDir && style === "plain" ? ["--no-color"] : []),
		],
		{
			terminal,
			env: env({
				DITERO_URL: `http://127.0.0.1:${server.port}`,
				DITERO_TOKEN: pat.token,
				TERM: "xterm-256color",
				COLORFGBG: arabic ? "15;0" : "0;15",
			}),
		},
	);
	await wait(
		() =>
			wires.some((wire) => wire.path === "/api/v1/me" && wire.status === 200) &&
			frames() > 1,
		"Startup did not finish",
	);
	await send("\x1b[B\r", () => frame().includes("Terminal list"));
	await send("\r", () => selectedTitle() !== null);
	await selectTitle(target.title);
	assert.ok(taskReads().length >= 1);
	assert.equal(await receipts(), 0);
	const open = async () => {
		const before = taskReads().length;
		await send("o", () => orderSelected(target.title));
		return before;
	};
	const refused = ["tie", "malformed"].includes(mode);
	if (refused) {
		// The local refusal is plain localized text, never the code or connection advice.
		const reason =
			mode === "tie"
				? "Tasks share an order key"
				: "A task has an unusable order key";
		await send("o", () => frame().includes(reason));
		assert.ok(frame().includes("Nothing was sent."));
		assert.equal(frame().includes("Request failed"), false);
		// The bounded read and both observations happen once; nothing is proposed.
		assert.equal(placementReads().length, 1);
		assert.equal(listReads().length, 1);
		assert.equal(writes().length, 0);
		assert.equal(frame().includes(notSent), false);
		assert.equal(await receipts(), 0);
		await assertRows(false, "A refused group must not change any row");
		frameLines = frame()
			.split(/\r?\n/)
			.map((line) => line.trimEnd());
		await send("q", () => child?.exitCode !== null);
		assert.equal(await child.exited, 0);
	} else {
		let readsBefore = await open();
		if (captureDir) {
			await settle("order-wide");
			capture("order-wide");
			await resizeTo(
				40,
				20,
				() => rawFrame().length > 0,
				"The narrow order frame was absent",
			);
			capture("order-narrow");
			// The field leads the 40x20 frame, above every sibling row, and the
			// typed digit echoes there without scrolling.
			await settle("order-narrow-field");
			assertNarrowOrderField(/^>$/, "The empty narrow prompt");
			await send("1", () =>
				frame()
					.split("\n")
					.some((line) => rowText(line) === "> 1"),
			);
			await settle("order-narrow-typed");
			assertNarrowOrderField(/^> 1$/, "The typed narrow echo");
			await send("\x7f", emptyPrompt);
			await settle("order-narrow-cleared");
			assertNarrowOrderField(/^>$/, "The cleared narrow prompt");
			await resizeTo(
				120,
				55,
				() => orderSelected(target.title),
				"The wide order frame did not return",
			);
		}
		// The ordering read uses done-unset pages; the group excludes other parents.
		assert.ok(placementReads().length === 1 && listReads().length === 1);
		assert.ok(
			taskReads().every((wire) => !new URLSearchParams(wire.query).has("done")),
			"Task reads must leave the done filter unset",
		);
		for (const read of taskReads()) {
			assert.ok(read.ids);
			assert.deepEqual(read.ids, [...read.ids].sort(), "Pages stay ID ordered");
		}
		if (mode === "move") {
			const ordering = taskReads().slice(readsBefore);
			assert.ok(ordering.length >= 2, "More than one page must be read");
			assert.ok(
				ordering
					.slice(1)
					.some((wire) => new URLSearchParams(wire.query).has("cursor")),
				"A later page must follow a cursor",
			);
			assert.ok(
				ordering.reduce((sum, wire) => sum + (wire.ids?.length ?? 0), 0) > 100,
			);
		}
		if (mode === "cancel-help-paste") {
			assert.ok(frame().includes(`Now at position ${from} of ${total}`));
			await send("?", () => !frame().includes(promptText));
			await send("\x1b", () => frame().includes(promptText));
			// A rejected paste repaints nothing, so it has no frame to await. The
			// input stream is ordered: an Enter on the still-empty prompt is the
			// barrier, and it could not stay on the prompt had the paste entered.
			terminal?.write("\x1b[200~1\n\x1b[201~");
			await send("\r");
			assert.ok(emptyPrompt(), "Pasted text must not enter the position");
			assert.equal(frame().includes(notSent), false);
			assert.equal(writes().length, 0);
			await send(String(to));
			await send("\r", () => frame().includes(notSent));
			await send("\x1b[200~y\n\x1b[201~");
			assert.equal(writes().length, 0);
			await send("\x1b", () => !frame().includes(notSent));
			assert.equal(writes().length, 0);
			assert.equal(await receipts(), 0);
			readsBefore = await open();
			await send("\x1b", () => !frame().includes(promptText));
			assert.equal(writes().length, 0);
			assert.equal(await receipts(), 0);
			assert.equal(placementReads().length, 2);
			assert.equal(listReads().length, 2);
			await assertRows(false, "Cancelled ordering must leave every row");
			frameLines = frame()
				.split(/\r?\n/)
				.map((line) => line.trimEnd());
			await send("q", () => child?.exitCode !== null);
			assert.equal(await child.exited, 0);
		} else {
			if (english) {
				assert.ok(frame().includes(`Now at position ${from} of ${total}`));
				assert.ok(
					frame().includes(
						parentTitle
							? `Group: subtasks of ${parentTitle}`
							: "Group: top-level tasks",
					),
				);
				if (mode === "move")
					assert.ok(frame().includes("2 subtasks stay attached"));
			}
			await send(String(to));
			await send("\r", () => frame().includes(notSent));
			if (captureDir) await settle("review-wide");
			const summary = frame();
			capture("review-wide");
			if (captureDir) {
				await resizeTo(
					40,
					20,
					() => frame().includes(notSent),
					"Narrow review absent",
				);
				capture("review-narrow");
				await resizeTo(
					120,
					55,
					() => frame().includes(notSent),
					"Wide review absent",
				);
			}
			await send("v", () => frame().includes("requestId"));
			const reviewed = captureReview();
			proposed = reviewed.key;
			if (english) {
				assert.ok(summary.includes(`Move from ${from} to ${to} of ${total}`));
				assert.ok(summary.includes(`Order key: ${proposed}`));
				assert.ok(
					summary.includes(
						next
							? `Before: ${next.title} (${next.id})`
							: "At the end of the group",
					),
				);
				if (!prev) assert.ok(summary.includes("At the start of the group"));
				assert.ok(summary.includes("Neighbors are not checked"));
			} else {
				assert.ok(summary.includes(proposed), "The summary must show the key");
			}
			assert.equal(writes().length, 0);
			assert.equal(await receipts(), 0);
			await send("\x1b[200~y\n\x1b[201~");
			assert.equal(writes().length, 0);
			await assertRows(false, "Review must not change any row");
			if (mode === "stale-self")
				await admin.query(
					"update task set notes='Concurrent edit' where id=$1",
					[target.id],
				);
			if (raced) raceKey = keyBetween(null, proposed);
			if (raced)
				await admin.query("update task set sort_key=$1 where id=$2", [
					raceKey,
					raced.id,
				]);
			if (mode === "revoked")
				await revokePersonalAccessToken(runtime, actor, pat.id);
			const rejected = ["revoked", "read", "stale-self"].includes(mode);
			const readsAtReview = taskReads().length;
			await send(
				"y",
				() =>
					writes().length === 1 &&
					writes()[0].status !== 0 &&
					(rejected
						? frame().includes(
								mode === "revoked"
									? "unauthorized"
									: mode === "read"
										? "forbidden"
										: "Request failed",
							) &&
							!frame().includes(notSent) &&
							!frame().includes(unconfirmed)
						: dropFirstResponse
							? frame().includes(unconfirmed)
							: taskReads().length > readsAtReview &&
								!frame().includes(notSent) &&
								!frame().includes(unconfirmed)),
			);
			const first = writes()[0];
			assert.equal(first.path, `/api/v1/tasks/${target.id}/placement`);
			assert.ok(first.key && /^[0-9a-f-]{36}$/.test(first.key));
			assert.equal(first.key, reviewed.requestId, "Wire key must match review");
			assert.ok(new TextEncoder().encode(first.body).length <= 4096);
			const body = JSON.parse(first.body);
			assert.equal(first.body, JSON.stringify(parseApiTaskPlacement(body)));
			assert.equal(
				body.sortKey,
				reviewed.key,
				"Wire body must carry the reviewed key",
			);
			assert.match(body.expectedState, /^[0-9a-f]{64}$/);
			assert.match(body.expectedTargetState, /^[0-9a-f]{64}$/);
			assert.deepEqual(
				{ ...body, expectedState: "", expectedTargetState: "" },
				{
					workspaceId: workspace,
					listId: list,
					expectedState: "",
					targetListId: list,
					expectedTargetState: "",
					sortKey: proposed,
					cascadeChildren: false,
					expectedChildrenState: null,
				},
			);
			if (["revoked", "read"].includes(mode)) {
				assert.equal(first.status, mode === "revoked" ? 401 : 403);
				assert.equal(await receipts(), 0);
				await assertRows(false, "A refused write must not change any row");
				assert.equal(frame().includes(target.title), false);
			} else if (mode === "stale-self") {
				assert.equal(first.status, 409);
				assert.equal(await receipts(), 0);
				await assertRows(false, "A stale write must not change any row");
				// A fresh read starts over; the stale review and token are gone.
				// The error frame still lists rows; only a frame after the reload counts.
				const reloads = taskReads().length;
				const painted = frames();
				await send(
					"r",
					() =>
						taskReads().length > reloads &&
						frames() > painted &&
						selectedTitle() !== null,
				);
				await selectTitle(target.title);
				await open();
				await send(String(to));
				await send("\r", () => frame().includes(notSent));
				await send("v", () => frame().includes("requestId"));
				// The fresh review is a new request with its own jittered key.
				const fresh = captureReview();
				assert.notEqual(fresh.requestId, reviewed.requestId);
				proposed = fresh.key;
				await send(
					"y",
					() => writes().length === 2 && writes()[1].status !== 0,
				);
				await wait(
					() => !frame().includes(notSent) && !frame().includes(unconfirmed),
					"Fresh order did not finish",
				);
				const second = writes()[1];
				assert.equal(second.status, 200);
				assert.notEqual(second.key, first.key);
				assert.equal(
					second.key,
					fresh.requestId,
					"Fresh wire key must match review",
				);
				assert.notEqual(
					JSON.parse(second.body).expectedState,
					body.expectedState,
				);
				assert.equal(JSON.parse(second.body).sortKey, fresh.key);
				assert.equal(
					first.body,
					JSON.stringify(body),
					"First body must be unchanged",
				);
				assert.equal(body.sortKey, reviewed.key);
				assert.equal(await receipts(), 1);
				assert.equal(placementReads().length, 2);
				assert.equal(listReads().length, 2);
				await assertRows(true, "The fresh order must change only the task");
			} else {
				assert.equal(first.status, 200);
				assert.equal(await receipts(), 1);
				await assertRows(true, "Only the ordered task may change");
				if (dropFirstResponse && mode === "retry") {
					await send(
						"r",
						() =>
							writes().length === 2 &&
							writes()[1].status !== 0 &&
							!frame().includes(notSent) &&
							!frame().includes(unconfirmed),
					);
					assert.deepEqual(writes()[1], first);
					assert.equal(JSON.parse(writes()[1].body).sortKey, reviewed.key);
					assert.equal(writes()[1].key, reviewed.requestId);
					assert.equal(await receipts(), 1);
				}
				if (!dropFirstResponse || mode === "retry") {
					if (arabic) {
						// The exact localized acknowledgement from messages/ar.json.
						assert.ok(arabicAck.length > 0);
						await wait(
							() => squash(frame()).includes(arabicAck[0]),
							"The Arabic acknowledgement was absent",
						);
						for (const part of arabicAck)
							assert.ok(
								squash(frame()).includes(part),
								"Arabic acknowledgement part",
							);
						assert.equal(frame().includes("Order request"), false);
					} else {
						await wait(
							() => frame().includes("Order request for position"),
							"The captured acknowledgement was absent",
						);
						assert.ok(
							frame().includes(
								`Order request for position ${to} of ${total} accepted.`,
							),
						);
						assert.ok(frame().includes("not guaranteed"));
						assert.ok(frame().includes("browse stays in ID order"));
					}
					if (captureDir) await settle("ack-wide");
					capture("ack-wide");
					// Acknowledgement only; browse stays ID ordered and the DB rank is read.
					assert.deepEqual(
						taskReads().at(-1)?.ids,
						[...(taskReads().at(-1)?.ids ?? [])].sort(),
					);
					const ranked = [...(await taskRows())]
						.filter(([, row]) => row.parent === target.parent)
						.sort((a, b) => (a[1].key < b[1].key ? -1 : 1))
						.map(([id]) => id);
					assert.equal(
						ranked.indexOf(target.id) + 1,
						raced ? to + 1 : to,
						raced
							? "A sibling race may place the task after the acknowledged rank"
							: "The task must hold the acknowledged rank",
					);
				}
				assert.equal(placementReads().length, 1);
				assert.equal(listReads().length, 1);
			}
			if (arabic || (captureDir && captured.has("ack-wide"))) {
				await resizeTo(
					40,
					20,
					() => (arabic ? /[؀-ۿ]/.test(frame()) : frame().length > 0),
					"The narrow acknowledgement frame was absent",
				);
				// Narrow terminals get the compact localized acceptance and caveat.
				await wait(
					() => squash(frame()).includes(compactAck),
					"The compact narrow acknowledgement was absent",
				);
				assert.equal(frame().includes("Order request"), false);
				capture("ack-narrow");
				assert.ok(
					captureDir === undefined || captured.has("ack-narrow"),
					"The narrow acknowledgement was not captured",
				);
			}
			frameLines = frame()
				.split(/\r?\n/)
				.map((line) => line.trimEnd());
			await send(
				mode === "uncertain-exit" ? "\x03" : "q",
				() => child?.exitCode !== null,
			);
			assert.equal(await child.exited, mode === "uncertain-exit" ? 130 : 0);
			if (mode === "uncertain-exit") {
				const line = output
					.split(/[\r\n]+/)
					.find((line) => line.includes('{"requestId":'));
				assert.ok(line, "Exact retry record was absent");
				assert.deepEqual(
					JSON.parse(line.slice(line.indexOf('{"requestId":'))),
					{
						requestId: first.key,
						endpoint: first.path,
						method: "PATCH",
						body,
					},
				);
				assert.equal(writes().length, 1);
				assert.equal(await receipts(), 1);
				await assertRows(true, "The committed write must persist");
			}
		}
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
	for (const wire of writes())
		patches.push({ status: wire.status, key: wire.key });
	passed = true;
} catch (error) {
	process.stderr.write(
		redact(
			`fixture failure in ${mode}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\nwires: ${JSON.stringify(
				wires.map(({ ids: _ids, body: _body, ...rest }) => rest),
			)}\nframe:\n${frame()}\n`,
		),
	);
	throw error;
} finally {
	clearTimeout(timeout);
	if (child && child.exitCode === null) {
		child.kill("SIGKILL");
		await child.exited;
	}
	terminal?.close();
	await cleanup("server", () => server?.stop(true));
	await cleanup("runtime pool", () => runtime.end());
	await cleanup("tasks", () =>
		admin.query("delete from task where list_id=$1", [list]),
	);
	await cleanup("list", () =>
		admin.query("delete from list where id=$1", [list]),
	);
	await cleanup("membership", () =>
		admin.query("delete from membership where workspace_id=$1", [workspace]),
	);
	await cleanup("workspace", () =>
		admin.query("delete from workspace where id=$1", [workspace]),
	);
	await cleanup("user", () =>
		admin.query('delete from "user" where id=$1', [actor]),
	);
	if (roleCreated) {
		await cleanup("role objects", () => admin.query(`drop owned by "${role}"`));
		await cleanup("role", () => admin.query(`drop role "${role}"`));
	}
	await cleanup("role absence", async () =>
		assert.equal(
			(
				await admin.query(
					"select count(*)::int count from pg_roles where rolname=$1",
					[role],
				)
			).rows[0].count,
			0,
		),
	);
	await cleanup("role sessions", async () =>
		assert.equal(
			(
				await admin.query(
					"select count(*)::int count from pg_stat_activity where usename=$1",
					[role],
				)
			).rows[0].count,
			0,
		),
	);
	await cleanup("receipts", async () =>
		assert.equal(
			(
				await admin.query(
					"select count(*)::int count from public_api_request where user_id=$1",
					[actor],
				)
			).rows[0].count,
			0,
		),
	);
	await cleanup("admin pool", () => admin.end());
}
assert.deepEqual(cleanupFailures, [], "Fixture cleanup must be complete");
assert.ok(passed);
if (captureDir) {
	assert.ok(
		Buffer.byteLength(output) <= 4 * 1024 * 1024,
		"Capture stream bound",
	);
	const screenshots = [...captured].map(([phase, value]) => {
		assert.equal(value.raw.includes(secret), false);
		const file = `${mode}-${style}-${phase}.ansi`;
		writeFileSync(join(captureDir, file), value.raw, {
			flag: "wx",
			mode: 0o600,
		});
		return {
			phase,
			file,
			columns: value.columns,
			rows: value.rows,
			sha256: createHash("sha256").update(value.raw).digest("hex"),
		};
	});
	writeFileSync(
		join(captureDir, `${mode}-${style}-terminal-output.ansi`),
		output,
		{
			flag: "wx",
			mode: 0o600,
		},
	);
	writeFileSync(
		join(captureDir, `${mode}-${style}-capture.json`),
		JSON.stringify({ mode, style, locale: arabic ? "ar" : "en", screenshots }),
		{ flag: "wx", mode: 0o600 },
	);
}
const safeFrame = frameLines.map((line) => redact(line)).slice(0, 55);
// Optional private runtime path; never a fixed machine path.
if (process.env.TUI_ORDERING_FRAME_PATH)
	writeFileSync(
		process.env.TUI_ORDERING_FRAME_PATH,
		`${safeFrame.join("\n")}\n`,
	);
process.stdout.write(
	JSON.stringify({
		mode,
		passed,
		requests: wires.length,
		writes: patches.length,
		patches,
		taskReads: taskReads().length,
		placementObservations: placementReads().length,
		listObservations: listReads().length,
		position: { from, to, total },
		key: proposed,
		frame: safeFrame,
		cleanup: true,
		directLogin: true,
	}),
);
