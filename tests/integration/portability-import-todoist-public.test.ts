import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Elysia } from "elysia";
import { escapeLiteral, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	CSV_V1_EXCLUSIONS,
	TODOIST_V1_EXCLUSIONS,
} from "../../src/domain/portability/providers/input.ts";
import { parseTodoistProjectCsv } from "../../src/domain/portability/providers/todoist.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import { importPlanRoutes } from "../../src/server/portability/import-routes.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const expectedDatabase =
	process.env.DITERO_TODOIST_TEST_DATABASE ?? "ditero_e2e";
let guarded = false;
let roleCreated = false;
const admin = new Pool({ connectionString: url });
let runtime: Pool;
let app: Pick<Elysia, "handle">;
const role = `ditero_todoist_test_${randomUUID().replaceAll("-", "")}`;
const fixture = readFileSync(
	new URL(
		"../fixtures/portability/providers/todoist-project-v1.csv",
		import.meta.url,
	),
);
const options = {
	exportedAt: "2026-01-15T00:00:00.000Z",
	projectFolderName: "Imported project",
	unsectionedListName: "Unsectioned",
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
	const conversion = await parseTodoistProjectCsv(bytes, names);
	return {
		source: { mode: "new" as const, id, label: "Todoist snapshot" },
		input: {
			kind: "provider",
			version: 1,
			adapter: conversion.adapter,
			adapterVersion: 1,
			identityMode: conversion.identityMode,
			sourceNamespace: conversion.sourceNamespace,
			snapshotSha256: conversion.snapshotSha256,
			projectFolderName: names.projectFolderName,
			unsectionedListName: names.unsectionedListName,
			exclusions: [...TODOIST_V1_EXCLUSIONS],
			originalCsvBase64: Buffer.from(bytes).toString("base64"),
		},
		mappings: {
			workspaces: {
				[conversion.document.data.workspaces[0]?.id ?? ""]: "todoist-target",
			},
			principals: { [conversion.document.sourceUserId]: "todoist-owner" },
		},
	};
}
function request(path: string, value?: unknown, actor = "todoist-owner") {
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
		await admin.query(
			"select owner_id from workspace where id='todoist-target'",
		)
	).rows;
	if (workspace.length && workspace[0].owner_id !== "todoist-owner")
		throw new Error("Fixture workspace ownership changed");
	const client = await admin.connect();
	try {
		await client.query("begin");
		await client.query(
			"delete from import_source where owner_user_id in ('todoist-owner','todoist-outsider')",
		);
		await client.query(
			"delete from task where list_id in (select id from list where workspace_id='todoist-target')",
		);
		await client.query("delete from list where workspace_id='todoist-target'");
		await client.query(
			"delete from folder where workspace_id='todoist-target'",
		);
		await client.query(
			"delete from membership where workspace_id='todoist-target'",
		);
		await client.query(
			"delete from workspace where id='todoist-target' and owner_id='todoist-owner'",
		);
		await client.query(
			"delete from \"user\" where id in ('todoist-owner','todoist-outsider')",
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
				"select (select count(*)::int from \"user\" where id in ('todoist-owner','todoist-outsider')) users,(select count(*)::int from workspace where id='todoist-target') workspaces,(select count(*)::int from import_source where owner_user_id in ('todoist-owner','todoist-outsider')) sources,(select count(*)::int from import_job where owner_user_id in ('todoist-owner','todoist-outsider')) jobs",
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
		application_name: "ditero-todoist-restricted-test",
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
		`insert into "user"(id,name,email,email_verified) values('todoist-owner','Owner','todoist-owner@example.test',false),('todoist-outsider','Outside','todoist-outside@example.test',false)`,
	);
	await admin.query(
		`insert into workspace(id,name,owner_id,kind) values('todoist-target','Target','todoist-owner','shared')`,
	);
	await admin.query(
		`insert into membership(id,user_id,workspace_id,role) values('todoist-seat','todoist-owner','todoist-target','owner')`,
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

test("direct restricted LOGIN previews/applies open snapshots with section names, parent order and no excluded effects", async () => {
	const value = await body();
	const plan = await save(value);
	expect(plan.report).toMatchObject({
		plannerVersion: 4,
		applySupported: true,
	});
	expect(plan.inputBinding).toMatchObject({
		adapter: "todoist-project-csv",
		identityMode: "snapshot-rows",
		snapshotSha256: value.input.snapshotSha256,
	});
	expect(await count("task")).toBe(0);
	expect((await apply(plan)).state).toBe("completed");
	expect((await admin.query("select name from folder")).rows).toEqual([
		{ name: "Imported project" },
	]);
	expect(
		(await admin.query("select title from list order by sort_key")).rows.map(
			(row) => row.title,
		),
	).toEqual(["Unsectioned", "Same section", "Same section", "Empty section"]);
	const tasks = (
		await admin.query(
			"select id,title,notes,priority,done,due_at,parent_id from task order by list_id,sort_key",
		)
	).rows;
	expect(tasks).toHaveLength(3);
	const parent = tasks.find((row) => row.title === "=literal @label");
	expect(tasks.find((row) => row.title === "Child")?.parent_id).toBe(parent.id);
	expect(parent.priority).toBe(3);
	expect(tasks.every((row) => row.done === false && row.due_at === null)).toBe(
		true,
	);
	for (const table of [
		"task_completion_event",
		"imported_completion_event",
		"karma_event",
		"notification_outbox",
		"reminder_state",
		"task_assignee",
		"comment",
		"attachment",
		"label",
	])
		expect(await count(table)).toBe(0);
	expect((await apply(plan)).state).toBe("completed");
	const replay = await save({
		...value,
		source: { mode: "existing", id: value.source.id },
	});
	expect(replay.documentDigest).toBe(plan.documentDigest);
	expect((await apply(replay)).state).toBe("completed");
	expect(await count("task")).toBe(3);
});
test("every exact-byte or mapping change refuses existing-source reuse and requires an explicit new copy", async () => {
	const value = await body();
	await save(value);
	const bom = Buffer.concat([Buffer.from([239, 187, 191]), fixture]);
	const changed = [
		bom,
		Buffer.from(
			fixture.toString().includes("\r\n")
				? fixture.toString().replaceAll("\r\n", "\n")
				: fixture.toString().replaceAll("\n", "\r\n"),
		),
		Buffer.from(fixture.toString().replace("every day", "tomorrow")),
		Buffer.from(fixture.toString().replace("Another task", "Edited task")),
	];
	for (const bytes of changed) {
		expect(bytes.equals(fixture)).toBe(false);
		const next = await body(bytes, value.source.id);
		const response = await request("plans", {
			...next,
			source: { mode: "existing", id: value.source.id },
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ code: "source-binding-conflict" });
	}
	const renamed = await body(fixture, value.source.id, {
		...options,
		projectFolderName: "Renamed",
	});
	expect(
		(
			await request("plans", {
				...renamed,
				source: { mode: "existing", id: value.source.id },
			})
		).status,
	).toBe(409);
	expect(await count("import_job")).toBe(1);
	expect(await count("task")).toBe(0);
	const separate = await save(await body(changed[2]));
	expect(separate.sourceId).not.toBe(value.source.id);
	expect(await count("import_source")).toBe(2);
});
test("forged digest, policy and ownership cannot create a plan or content", async () => {
	const value = await body();
	for (const input of [
		{ ...value.input, snapshotSha256: "0".repeat(64) },
		{ ...value.input, exclusions: [...TODOIST_V1_EXCLUSIONS].reverse() },
		{ ...value.input, unknown: "private" },
	])
		expect((await request("plans", { ...value, input })).status).toBe(400);
	const foreignPrincipal = await request("plans", value, "todoist-outsider");
	expect(foreignPrincipal.status).toBe(400);
	expect(await foreignPrincipal.json()).toEqual({ code: "invalid-mappings" });
	const outsider = {
		...value,
		mappings: {
			...value.mappings,
			principals: Object.fromEntries(
				Object.keys(value.mappings.principals).map((id) => [
					id,
					"todoist-outsider",
				]),
			),
		},
	};
	const unauthorized = await request("plans", outsider, "todoist-outsider");
	expect(unauthorized.status).toBe(403);
	expect(await unauthorized.json()).toEqual({
		code: "invalid-workspace-mapping",
	});
	expect(await count("import_source")).toBe(0);
	expect(await count("import_job")).toBe(0);
	expect(await count("task")).toBe(0);
});
test("database validates exact bindings, pins immutable source/job proof and rejects raw forgery", async () => {
	const value = await body();
	const plan = await save(value);
	const { originalCsvBase64: _bytes, ...binding } = value.input;
	expect(
		(
			await runtime.query(
				"select public.import_provider_binding_valid($1::jsonb) valid",
				[JSON.stringify(binding)],
			)
		).rows[0].valid,
	).toBe(true);
	for (const changed of [
		{ ...binding, snapshotSha256: "0".repeat(64) },
		{ ...binding, sourceNamespace: "11111111-1111-4111-8111-111111111111" },
		{ ...binding, exclusions: [...TODOIST_V1_EXCLUSIONS].reverse() },
		{ ...binding, projectFolderName: "" },
		{ ...binding, unknown: true },
	])
		expect(
			(
				await runtime.query(
					"select public.import_provider_binding_valid($1::jsonb) valid",
					[JSON.stringify(changed)],
				)
			).rows[0].valid,
		).toBe(false);
	const client = await runtime.connect();
	try {
		await client.query("begin");
		await client.query("set local ditero.user_id='todoist-owner'");
		expect(
			(
				await client.query(
					"select input_binding from import_source where id=$1",
					[value.source.id],
				)
			).rows,
		).toEqual([{ input_binding: binding }]);
		const changed = await client.query(
			"update import_source set input_binding=jsonb_set(input_binding,'{projectFolderName}','\"changed\"') where id=$1",
			[value.source.id],
		);
		expect(changed.rowCount).toBe(0);
		expect(
			(
				await client.query(
					"select input_binding from import_source where id=$1",
					[value.source.id],
				)
			).rows,
		).toEqual([{ input_binding: binding }]);
		for (const forged of [
			{ ...binding, snapshotSha256: "0".repeat(64) },
			{ ...binding, sourceNamespace: "11111111-1111-4111-8111-111111111111" },
			{ ...binding, exclusions: [...TODOIST_V1_EXCLUSIONS].reverse() },
			{ ...binding, projectFolderName: "" },
			{ ...binding, unknown: true },
		]) {
			await client.query("savepoint forged_binding");
			await expect(
				client.query(
					"insert into import_source(id,owner_user_id,label,format,schema_version,source_user_id,input_binding) values($1,'todoist-owner','Forged','todoist-project-csv',1,$2,$3::jsonb)",
					[
						randomUUID(),
						`migration:todoist-project-csv:1:${forged.sourceNamespace}:owner`,
						JSON.stringify(forged),
					],
				),
			).rejects.toMatchObject({ code: "23514" });
			await client.query("rollback to savepoint forged_binding");
		}
	} finally {
		await client.query("rollback");
		client.release();
	}
	await expect(
		admin.query(
			"update import_source set input_binding=jsonb_set(input_binding,'{projectFolderName}','\"changed\"') where id=$1",
			[value.source.id],
		),
	).rejects.toMatchObject({ code: "23514" });
	await expect(
		admin.query("update import_job set input_binding=null where id=$1", [
			plan.id,
		]),
	).rejects.toMatchObject({ code: "23514" });
});
test("current role loss and outsider access refuse saved apply without content effects", async () => {
	const plan = await save(await body());
	expect(
		(await request(`plans/${plan.id}`, undefined, "todoist-outsider")).status,
	).toBe(404);
	await admin.query(
		"update membership set role='viewer' where id='todoist-seat'",
	);
	const response = await request(`plans/${plan.id}/apply`, {
		planDigest: plan.planDigest,
		counts: plan.report.counts,
	});
	expect(response.status).toBe(403);
	expect(await count("task")).toBe(0);
	expect(await count("folder")).toBe(0);
	expect(await count("notification_outbox")).toBe(0);
});
test("existing CSV predicate remains exact and accepts only its unchanged version1 binding shape", async () => {
	const old = readFileSync(
		new URL("../../drizzle/0069_import_provider_binding.sql", import.meta.url),
		"utf8",
	);
	const current = readFileSync(
		new URL("../../drizzle/0071_todoist_provider_binding.sql", import.meta.url),
		"utf8",
	);
	expect(current).toContain(
		old.slice(
			old.indexOf("  SELECT coalesce"),
			old.indexOf("\n$$;", old.indexOf("  SELECT coalesce")),
		),
	);
	const binding = {
		kind: "provider",
		version: 1,
		adapter: "ditero-csv",
		adapterVersion: 1,
		sourceNamespace: "fcb28f31-12ae-4c9d-82f2-1289d9fcb411",
		identityMode: "stable-ids",
		exclusions: [...CSV_V1_EXCLUSIONS],
	};
	expect(
		(
			await runtime.query(
				"select public.import_provider_binding_valid($1::jsonb) valid",
				[JSON.stringify(binding)],
			)
		).rows[0].valid,
	).toBe(true);
	expect(
		(
			await runtime.query(
				"select public.import_provider_binding_valid($1::jsonb) valid",
				[JSON.stringify({ ...binding, projectFolderName: "extra" })],
			)
		).rows[0].valid,
	).toBe(false);
});
