import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Elysia } from "elysia";
import { escapeLiteral, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { TRELLO_V1_EXCLUSIONS } from "../../src/domain/portability/providers/input.ts";
import { parseTrelloBoardJson } from "../../src/domain/portability/providers/trello.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import { importPlanRoutes } from "../../src/server/portability/import-routes.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const expectedDatabase =
	process.env.DITERO_TRELLO_TEST_DATABASE ?? "ditero_e2e";
let guarded = false;
let roleCreated = false;
const admin = new Pool({ connectionString: url });
let runtime: Pool;
let app: Pick<Elysia, "handle">;
const scope = randomUUID().replaceAll("-", "");
const owner = `trello-owner-${scope}`;
const outsider = `trello-outsider-${scope}`;
const target = `trello-target-${scope}`;
const seat = `trello-seat-${scope}`;
const role = `ditero_trello_test_${randomUUID().replaceAll("-", "")}`;
const fixture = readFileSync(
	new URL(
		"../fixtures/portability/providers/trello-board-v1.json",
		import.meta.url,
	),
);
const options = {
	exportedAt: "2026-01-15T00:00:00.000Z",
};
const guards = makeGuards(["http://localhost"], async (headers) =>
	headers.get("x-user")
		? ({ user: { id: headers.get("x-user") } } as Session)
		: null,
);
async function body(
	bytes: Uint8Array = fixture,
	id = randomUUID(),
	names = options,
) {
	const conversion = await parseTrelloBoardJson(bytes, names);
	return {
		source: { mode: "new" as const, id, label: "Trello board" },
		input: {
			kind: "provider",
			version: 1,
			adapter: conversion.adapter,
			adapterVersion: 1,
			identityMode: conversion.identityMode,
			sourceNamespace: conversion.sourceNamespace,
			snapshotSha256: conversion.snapshotSha256,
			boardIdSha256: conversion.boardIdSha256,
			exclusions: [...TRELLO_V1_EXCLUSIONS],
			originalJsonBase64: Buffer.from(bytes).toString("base64"),
		},
		mappings: {
			workspaces: {
				[conversion.document.data.workspaces[0]?.id ?? ""]: target,
			},
			principals: { [conversion.document.sourceUserId]: owner },
		},
	};
}
function request(path: string, value?: unknown, actor = owner) {
	return app.handle(
		new Request(`http://localhost/api/portability/import/${path}`, {
			method: value === undefined ? "GET" : "POST",
			headers: {
				origin: "http://localhost",
				"x-user": actor,
				"content-type": "application/json",
			},
			...(value === undefined ? {} : { body: JSON.stringify(value) }),
		}),
	);
}
async function save(
	value: Omit<Awaited<ReturnType<typeof body>>, "source"> & {
		source:
			| { mode: "new"; id: string; label: string }
			| { mode: "existing"; id: string };
	},
) {
	const response = await request("plans", value);
	expect(response.status, await response.clone().text()).toBe(200);
	return response.json();
}
async function apply(plan: {
	id: string;
	planDigest: string;
	report: { counts: unknown };
}) {
	const response = await request(`plans/${plan.id}/apply`, {
		planDigest: plan.planDigest,
		counts: plan.report.counts,
	});
	expect(response.status, await response.clone().text()).toBe(200);
	return response.json();
}
async function count(table: string) {
	return (await admin.query(`select count(*)::int n from ${table}`)).rows[0]
		.n as number;
}
async function cleanupRows() {
	if (!guarded) return;
	const workspace = (
		await admin.query(`select owner_id from workspace where id='${target}'`)
	).rows;
	if (workspace.length && workspace[0].owner_id !== owner)
		throw new Error("Fixture workspace ownership changed");
	const client = await admin.connect();
	try {
		await client.query("begin");
		await client.query(
			`delete from import_source where owner_user_id in ('${owner}','${outsider}')`,
		);
		await client.query(
			`delete from task where list_id in (select id from list where workspace_id='${target}')`,
		);
		await client.query(`delete from list where workspace_id='${target}'`);
		await client.query(`delete from folder where workspace_id='${target}'`);
		await client.query(`delete from membership where workspace_id='${target}'`);
		await client.query(
			`delete from workspace where id='${target}' and owner_id='${owner}'`,
		);
		await client.query(
			`delete from "user" where id in ('${owner}','${outsider}')`,
		);
		await client.query("commit");
	} catch (error) {
		try {
			await client.query("rollback");
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				"Fixture cleanup and rollback failed",
				{ cause: error },
			);
		}
		throw error;
	} finally {
		client.release();
	}
	expect(
		(
			await admin.query(
				`select (select count(*)::int from "user" where id in ('${owner}','${outsider}')) users,(select count(*)::int from workspace where id='${target}') workspaces,(select count(*)::int from import_source where owner_user_id in ('${owner}','${outsider}')) sources,(select count(*)::int from import_job where owner_user_id in ('${owner}','${outsider}')) jobs`,
			)
		).rows[0],
	).toEqual({ users: 0, workspaces: 0, sources: 0, jobs: 0 });
}
beforeAll(async () => {
	expect(process.env.NODE_ENV).toBe("test");
	expect(
		(await admin.query("select current_database() database")).rows[0].database,
	).toBe(expectedDatabase);
	guarded = true;

	const password = randomBytes(32).toString("hex");
	await admin.query(
		`create role ${role} login nosuperuser nocreatedb nocreaterole noinherit nobypassrls password ${escapeLiteral(password)}`,
	);
	roleCreated = true;
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to ${role}`,
	);
	const runtimeUrl = new URL(url);
	runtimeUrl.username = role;
	runtimeUrl.password = password;
	runtime = new Pool({
		connectionString: runtimeUrl.toString(),
		application_name: "ditero-trello-restricted-test",
	});
	const evidence = (
		await runtime.query(
			"select session_user,current_user,rolsuper,rolbypassrls,rolinherit,rolcanlogin,(select count(*)::int from pg_auth_members where member=(select oid from pg_roles where rolname=current_user)) memberships,(select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relowner=(select oid from pg_roles where rolname=current_user)) owned from pg_roles where rolname=current_user",
		)
	).rows[0];
	expect(evidence).toEqual({
		session_user: role,
		current_user: role,
		rolsuper: false,
		rolbypassrls: false,
		rolinherit: false,
		rolcanlogin: true,
		memberships: 0,
		owned: 0,
	});
	app = new Elysia().use(importPlanRoutes(runtime, guards));
});
beforeEach(async () => {
	await cleanupRows();
	await admin.query(
		`insert into "user"(id,name,email,email_verified) values('${owner}','Owner','${owner}@example.test',false),('${outsider}','Outside','${outsider}@example.test',false)`,
	);
	await admin.query(
		`insert into workspace(id,name,owner_id,kind) values('${target}','Target','${owner}','shared')`,
	);
	await admin.query(
		`insert into membership(id,user_id,workspace_id,role) values('${seat}','${owner}','${target}','owner')`,
	);
});
afterAll(async () => {
	const failures: { step: string; error: unknown }[] = [];
	async function attempt(step: string, operation: () => Promise<unknown>) {
		try {
			await operation();
		} catch (error) {
			failures.push({ step, error });
		}
	}
	await attempt("close runtime pool", async () => runtime?.end());
	await attempt("remove owned fixture rows", cleanupRows);
	if (roleCreated) {
		await attempt("verify no runtime sessions", async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_stat_activity where usename=$1",
						[role],
					)
				).rows[0].n,
			).toBe(0);
		});
		await attempt("remove owned runtime grants", () =>
			admin.query(`drop owned by ${role}`),
		);
		await attempt("drop owned runtime role", () =>
			admin.query(`drop role ${role}`),
		);
		await attempt("verify runtime role absence", async () => {
			expect(
				(
					await admin.query(
						"select count(*)::int n from pg_roles where rolname=$1",
						[role],
					)
				).rows[0].n,
			).toBe(0);
		});
	}
	await attempt("close admin pool", () => admin.end());
	if (failures.length)
		throw new AggregateError(
			failures.map((failure) => failure.error),
			`Fixture cleanup failed: ${failures.map((failure) => `${failure.step}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`).join("; ")}`,
			{ cause: failures[0]?.error },
		);
});

async function ownedTasks() {
	return (
		await admin.query(
			"select t.id,t.title,t.notes,t.done,t.due_at,t.parent_id,t.rrule,t.reminder_time from task t join list l on l.id=t.list_id where l.workspace_id=$1 order by t.id",
			[target],
		)
	).rows;
}
const excludedTables = [
	"task_completion_event",
	"imported_completion_event",
	"karma_event",
	"notification_outbox",
	"reminder_state",
	"task_assignee",
	"comment",
	"attachment",
	"label",
	"membership_key",
];

test("restricted LOGIN previews and applies ordered plain lists and open cards exactly once without excluded effects", async () => {
	const value = await body();
	const baseline = await Promise.all(excludedTables.map(count));
	const plan = await save(value);
	expect(plan.report).toMatchObject({
		plannerVersion: 4,
		applySupported: true,
	});
	expect(plan.inputBinding).toMatchObject({
		adapter: "trello-board-json",
		identityMode: "stable-ids",
		boardIdSha256: value.input.boardIdSha256,
		snapshotSha256: value.input.snapshotSha256,
		exclusions: [...TRELLO_V1_EXCLUSIONS],
	});
	expect(await ownedTasks()).toEqual([]);
	expect((await apply(plan)).state).toBe("completed");
	expect(
		(
			await admin.query("select name from folder where workspace_id=$1", [
				target,
			])
		).rows,
	).toEqual([{ name: "Launch board" }]);
	expect(
		(
			await admin.query(
				"select title,kind from list where workspace_id=$1 order by sort_key",
				[target],
			)
		).rows,
	).toEqual([
		{ title: "Doing ünïcode ✓", kind: "tasks" },
		{ title: "To do", kind: "tasks" },
		{ title: "Done", kind: "tasks" },
	]);
	const tasks = await ownedTasks();
	expect(tasks.map((row) => row.title).sort()).toEqual([
		"Draft 📝",
		"Review",
		"Ship it",
		"Write plan",
	]);
	expect(tasks.find((row) => row.title === "Write plan")?.notes).toBe(
		"Line one\nLine two",
	);
	expect(
		tasks.every(
			(row) =>
				!row.done &&
				row.due_at === null &&
				row.parent_id === null &&
				row.rrule === null &&
				row.reminder_time === null,
		),
	).toBe(true);
	expect(
		(
			await admin.query(
				"select t.title from task t join list l on l.id=t.list_id where l.workspace_id=$1 and l.title='To do' order by t.sort_key",
				[target],
			)
		).rows,
	).toEqual([{ title: "Review" }, { title: "Write plan" }]);
	expect(await Promise.all(excludedTables.map(count))).toEqual(baseline);
	expect((await apply(plan)).state).toBe("completed");
	const replay = await save({
		...value,
		source: { mode: "existing", id: value.source.id },
	});
	expect((await apply(replay)).state).toBe("completed");
	expect(await ownedTasks()).toEqual(tasks);
	expect(await Promise.all(excludedTables.map(count))).toEqual(baseline);
});

test("stable board identity survives changed exports but changed bytes require an explicit separate source", async () => {
	const value = await body();
	const original = await save(value);
	const changed = await body(
		Buffer.from(fixture.toString().replace("Write plan", "Updated plan")),
	);
	expect(changed.input.sourceNamespace).toBe(value.input.sourceNamespace);
	expect(changed.input.boardIdSha256).toBe(value.input.boardIdSha256);
	expect(changed.input.snapshotSha256).not.toBe(value.input.snapshotSha256);
	const refused = await request("plans", {
		...changed,
		source: { mode: "existing", id: value.source.id },
	});
	expect(refused.status).toBe(409);
	expect(await refused.json()).toEqual({ code: "source-binding-conflict" });
	expect(await ownedTasks()).toEqual([]);
	const separate = await save(changed);
	expect(separate.sourceId).not.toBe(original.sourceId);
	expect((await apply(original)).state).toBe("completed");
	expect((await apply(separate)).state).toBe("completed");
	const tasks = await ownedTasks();
	expect(tasks).toHaveLength(8);
	expect(tasks.filter((row) => row.title === "Write plan")).toHaveLength(1);
	expect(tasks.filter((row) => row.title === "Updated plan")).toHaveLength(1);
});

test("tampered metadata, policy and original bytes fail before storing a plan", async () => {
	const value = await body();
	for (const input of [
		{ ...value.input, snapshotSha256: "0".repeat(64) },
		{ ...value.input, boardIdSha256: "0".repeat(64) },
		{ ...value.input, exclusions: [...TRELLO_V1_EXCLUSIONS].reverse() },
		{ ...value.input, unknown: true },
		{
			...value.input,
			originalJsonBase64: Buffer.from(
				fixture.toString().replace("Write plan", "Changed"),
			).toString("base64"),
		},
	])
		expect((await request("plans", { ...value, input })).status).toBe(400);
	const board = JSON.parse(fixture.toString()) as {
		closed: boolean;
		cards: {
			closed: boolean;
			dueComplete: boolean;
			idBoard: string;
			idList: string;
		}[];
	};
	for (const [mutate, code] of [
		[
			(copy: typeof board) => {
				copy.closed = true;
			},
			"unsupported-content",
		],
		[
			(copy: typeof board) => {
				copy.cards[0].closed = true;
			},
			"unsupported-content",
		],
		[
			(copy: typeof board) => {
				copy.cards[0].dueComplete = true;
			},
			"unsupported-content",
		],
		[
			(copy: typeof board) => {
				copy.cards[0].idBoard = "111111111111111111111111";
			},
			"invalid-graph",
		],
		[
			(copy: typeof board) => {
				copy.cards[0].idList = "111111111111111111111111";
			},
			"invalid-graph",
		],
	] as const) {
		const copy = structuredClone(board);
		mutate(copy);
		const response = await request("plans", {
			...value,
			input: {
				...value.input,
				originalJsonBase64: Buffer.from(JSON.stringify(copy)).toString(
					"base64",
				),
			},
		});
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ code });
	}
	expect(
		(
			await admin.query(
				"select count(*)::int n from import_source where owner_user_id=$1",
				[owner],
			)
		).rows[0].n,
	).toBe(0);
	expect(await ownedTasks()).toEqual([]);
});

test("owner mapping, viewer role and outsider access remain enforced under RLS", async () => {
	const value = await body();
	const wrongOwner = await request("plans", value, outsider);
	expect(wrongOwner.status).toBe(400);
	expect(await wrongOwner.json()).toEqual({ code: "invalid-mappings" });
	const outsideMapping = {
		...value,
		mappings: {
			...value.mappings,
			principals: Object.fromEntries(
				Object.keys(value.mappings.principals).map((id) => [id, outsider]),
			),
		},
	};
	const unauthorized = await request("plans", outsideMapping, outsider);
	expect(unauthorized.status).toBe(403);
	expect(await unauthorized.json()).toEqual({
		code: "invalid-workspace-mapping",
	});
	const plan = await save(value);
	expect((await request(`plans/${plan.id}`, undefined, outsider)).status).toBe(
		404,
	);
	await admin.query("update membership set role='viewer' where id=$1", [seat]);
	expect((await request("plans", await body())).status).toBe(403);
	expect(
		(
			await request(`plans/${plan.id}/apply`, {
				planDigest: plan.planDigest,
				counts: plan.report.counts,
			})
		).status,
	).toBe(403);
	expect(await ownedTasks()).toEqual([]);
});

test("database predicate accepts the exact Trello binding and rejects shape or namespace forgery", async () => {
	const value = await body();
	const { originalJsonBase64: _bytes, ...binding } = value.input;
	const valid = async (value: unknown) =>
		(
			await runtime.query(
				"select public.import_provider_binding_valid($1::jsonb) valid",
				[JSON.stringify(value)],
			)
		).rows[0].valid;
	expect(await valid(binding)).toBe(true);
	for (const forged of [
		{ ...binding, sourceNamespace: "11111111-1111-4111-8111-111111111111" },
		{ ...binding, boardIdSha256: "0".repeat(64) },
		{ ...binding, snapshotSha256: "invalid" },
		{ ...binding, exclusions: [...TRELLO_V1_EXCLUSIONS].reverse() },
		{ ...binding, originalJsonBase64: _bytes },
	])
		expect(await valid(forged)).toBe(false);
	const plan = await save(value);
	await expect(
		admin.query(
			"update import_source set input_binding=jsonb_set(input_binding,'{snapshotSha256}',to_jsonb($2::text)) where id=$1",
			[value.source.id, "0".repeat(64)],
		),
	).rejects.toMatchObject({ code: "23514" });
	await expect(
		admin.query("update import_job set input_binding=null where id=$1", [
			plan.id,
		]),
	).rejects.toMatchObject({ code: "23514" });
});
