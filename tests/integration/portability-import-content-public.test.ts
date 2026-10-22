import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import { escapeLiteral, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as tables from "../../src/db/schema.ts";
import { parseContentProvider } from "../../src/domain/portability/providers/content.ts";
import type { ContentProvider } from "../../src/domain/portability/providers/content-common.ts";
import { contentBinding } from "../../src/domain/portability/providers/content-input.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import { overdueSweep } from "../../src/server/notifications/events.ts";
import { importPlanRoutes } from "../../src/server/portability/import-routes.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const expectedDatabase =
	process.env.DITERO_CONTENT_TEST_DATABASE ?? "ditero_e2e";
let guarded = false;
let roleCreated = false;
const admin = new Pool({ connectionString: url });
let runtime: Pool;
let app: Pick<Elysia, "handle">;
const role = `ditero_content_test_${randomUUID().replaceAll("-", "")}`;
const cases: { provider: ContentProvider; file: string; tasks: number }[] = [
	{ provider: "todoist", file: "todoist-content.csv", tasks: 5 },
	{ provider: "ticktick", file: "ticktick-backup.csv", tasks: 6 },
	{ provider: "microsoft", file: "microsoft-todo-outlook.csv", tasks: 2 },
	{ provider: "trello", file: "trello-content.json", tasks: 4 },
	{ provider: "generic-csv", file: "generic-tasks.csv", tasks: 3 },
];
function fixture(file: string) {
	return readFileSync(
		new URL(`../fixtures/portability/providers/${file}`, import.meta.url),
	);
}
const options = {
	exportedAt: "2026-01-15T00:00:00.000Z",
	projectFolderName: "Imported project",
	unsectionedListName: "Unsectioned",
	timezone: "UTC",
};
const guards = makeGuards(["http://localhost"], async (headers) =>
	headers.get("x-user")
		? ({ user: { id: headers.get("x-user") } } as Session)
		: null,
);
async function body(
	provider: ContentProvider,
	bytes: Uint8Array,
	id = randomUUID(),
	exportedAt = options.exportedAt,
) {
	const conversion = await parseContentProvider(provider, bytes, {
		...options,
		exportedAt,
	});
	return {
		source: { mode: "new" as const, id, label: `${provider} snapshot` },
		input: {
			...contentBinding(conversion),
			originalBase64: Buffer.from(bytes).toString("base64"),
		},
		mappings: {
			workspaces: {
				[conversion.document.data.workspaces[0]?.id ?? ""]: "content-target",
			},
			principals: { [conversion.document.sourceUserId]: "content-owner" },
		},
	};
}
function request(path: string, value?: unknown, actor = "content-owner") {
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
const baselineCounts = new Map<string, number>();
async function rowCount(table: string) {
	return (await admin.query(`select count(*)::int n from ${table}`)).rows[0]
		.n as number;
}
async function count(table: string) {
	const baseline = baselineCounts.get(table);
	if (baseline === undefined) throw new Error(`Missing baseline for ${table}`);
	return (await rowCount(table)) - baseline;
}
async function cleanupRows() {
	if (!guarded) return;
	const workspace = (
		await admin.query(
			"select owner_id from workspace where id='content-target'",
		)
	).rows;
	if (workspace.length && workspace[0].owner_id !== "content-owner")
		throw new Error("Fixture workspace ownership changed");
	const client = await admin.connect();
	try {
		await client.query("begin");
		await client.query(
			"delete from import_source where owner_user_id in ('content-owner','content-outsider','content-viewer')",
		);
		await client.query(
			"delete from task where list_id in (select id from list where workspace_id='content-target')",
		);
		await client.query("delete from list where workspace_id='content-target'");
		await client.query(
			"delete from label where workspace_id in ('content-target','content-other')",
		);
		await client.query(
			"delete from folder where workspace_id='content-target'",
		);
		await client.query(
			"delete from membership where workspace_id='content-target'",
		);
		await client.query(
			"delete from workspace where id in ('content-target','content-other') and owner_id='content-owner'",
		);
		await client.query(
			"delete from \"user\" where id in ('content-owner','content-outsider','content-viewer')",
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
				"select (select count(*)::int from \"user\" where id in ('content-owner','content-outsider','content-viewer')) users,(select count(*)::int from workspace where id in ('content-target','content-other')) workspaces,(select count(*)::int from import_source where owner_user_id in ('content-owner','content-outsider','content-viewer')) sources,(select count(*)::int from import_job where owner_user_id in ('content-owner','content-outsider','content-viewer')) jobs",
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
		application_name: "ditero-content-restricted-test",
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
	// Other integration files retain their own rows in the shared serial fixture.
	for (const table of [
		"task",
		"label",
		"task_label",
		"import_source",
		"notification_outbox",
		"reminder_state",
		"task_assignee",
		"comment",
		"attachment",
		"task_completion_event",
		"karma_event",
	])
		baselineCounts.set(table, await rowCount(table));
	await admin.query(
		`insert into "user"(id,name,email,email_verified) values('content-owner','Owner','content-owner@example.test',false),('content-outsider','Outside','content-outside@example.test',false),('content-viewer','Viewer','content-viewer@example.test',false)`,
	);
	await admin.query(
		`insert into workspace(id,name,owner_id,kind) values('content-target','Target','content-owner','shared')`,
	);
	await admin.query(
		`insert into workspace(id,name,owner_id,kind) values('content-other','Other','content-owner','shared')`,
	);
	await admin.query(
		`insert into membership(id,user_id,workspace_id,role) values('content-seat','content-owner','content-target','owner'),('content-viewer-seat','content-viewer','content-target','viewer')`,
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

test.each(
	cases,
)("$provider previews and applies through the restricted LOGIN, without duplicate writes or notification side effects", async ({
	provider,
	file,
	tasks,
}) => {
	const bytes = fixture(file),
		value = await body(provider, bytes);
	const plan = await save(value);
	expect(plan.report).toMatchObject({
		plannerVersion: 4,
		applySupported: true,
	});
	expect(plan.inputBinding).toMatchObject({
		adapter: "provider-content",
		provider,
		notices: value.input.notices,
	});
	expect(await count("task")).toBe(0);
	expect((await apply(plan)).state).toBe("completed");
	expect(await count("task")).toBe(tasks);
	expect(
		(
			await admin.query(
				"select reminder_time,repeat_every_min,max_repeats,fallback_user_id,urgent from task where list_id in (select id from list where workspace_id='content-target')",
			)
		).rows.every(
			(row) =>
				row.reminder_time === null &&
				row.repeat_every_min === null &&
				row.max_repeats === null &&
				row.fallback_user_id === null &&
				!row.urgent,
		),
	).toBe(true);
	for (const table of [
		"notification_outbox",
		"reminder_state",
		"task_assignee",
		"comment",
		"attachment",
		"task_completion_event",
		"karma_event",
	])
		expect(await count(table)).toBe(0);
	expect((await apply(plan)).state).toBe("completed");
	const replay = await save({
		...value,
		source: { mode: "existing", id: value.source.id },
	});
	expect((await apply(replay)).state).toBe("completed");
	expect(await count("task")).toBe(tasks);
	expect(
		(
			await request("plans", {
				...value,
				input: { ...value.input, timezone: "Europe/Berlin" },
				source: { mode: "existing", id: value.source.id },
			})
		).status,
	).toBe(409);
	const changed = Buffer.concat([Buffer.from([239, 187, 191]), bytes]);
	const rebound = await body(provider, changed, value.source.id);
	expect(
		(
			await request("plans", {
				...rebound,
				source: { mode: "existing", id: value.source.id },
			})
		).status,
	).toBe(409);
	expect(
		(
			await request(
				`plans/${plan.id}/apply`,
				{ planDigest: plan.planDigest, counts: plan.report.counts },
				"content-outsider",
			)
		).status,
	).toBe(404);
});

test("binding forgery, unauthenticated access and foreign workspace mappings fail before writes", async () => {
	const value = await body("generic-csv", fixture("generic-tasks.csv"));
	for (const input of [
		{ ...value.input, notices: [] },
		{ ...value.input, snapshotSha256: "0".repeat(64) },
		{ ...value.input, provider: "__proto__" },
	])
		expect((await request("plans", { ...value, input })).status).toBe(400);
	const unauthorized = await app.handle(
		new Request("http://localhost/api/portability/import/plans", {
			method: "POST",
			headers: {
				origin: "http://localhost",
				"content-type": "application/json",
			},
			body: JSON.stringify(value),
		}),
	);
	expect(unauthorized.status).toBe(401);
	expect((await request("plans", value, "content-outsider")).status).toBe(400);
	const foreign = {
		...value,
		mappings: {
			...value.mappings,
			principals: Object.fromEntries(
				Object.keys(value.mappings.principals).map((id) => [
					id,
					"content-outsider",
				]),
			),
		},
	};
	expect((await request("plans", foreign, "content-outsider")).status).toBe(
		403,
	);
	expect(await count("import_source")).toBe(0);
	expect(await count("task")).toBe(0);
	const { originalBase64: _bytes, ...binding } = value.input;
	expect(
		(
			await runtime.query(
				"select public.import_provider_binding_valid($1::jsonb) valid",
				[JSON.stringify(binding)],
			)
		).rows[0].valid,
	).toBe(true);
	for (const changed of [
		{ ...binding, provider: null },
		{ ...binding, provider: "unknown" },
		{ ...binding, sourceNamespace: "11111111-1111-4111-8111-111111111111" },
		{ ...binding, notices: [{ code: null, path: "export", count: 1 }] },
		{
			...binding,
			notices: [{ code: "partial-export", path: "export", count: 50001 }],
		},
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
});

test("a viewer of the target workspace cannot plan or apply a provider import", async () => {
	const value = await body("generic-csv", fixture("generic-tasks.csv"));
	const viewer = {
		...value,
		mappings: {
			...value.mappings,
			principals: Object.fromEntries(
				Object.keys(value.mappings.principals).map((id) => [
					id,
					"content-viewer",
				]),
			),
		},
	};
	const response = await request("plans", viewer, "content-viewer");
	expect([403, 404]).toContain(response.status);
	expect(await count("import_source")).toBe(0);
	expect(await count("task")).toBe(0);
});

test("provider labels reuse same-named labels of the target workspace only and are idempotent", async () => {
	await admin.query(
		"insert into label(id,workspace_id,name,color) values('pre-home','content-target','home','teal'),('foreign-work','content-other','work','red')",
	);
	const csv = (title: string) =>
		Buffer.from(`title,labels\n${title},"home ;Home; work "\n`);
	const links = async (title: string) =>
		(
			await admin.query(
				"select l.id,l.workspace_id,l.name,l.color from task_label tl join task t on t.id=tl.task_id join label l on l.id=tl.label_id where t.title=$1 order by l.name",
				[title],
			)
		).rows;
	const first = await body("generic-csv", csv("First"));
	const plan = await save(first);
	expect(plan.report.counts.blocked).toBe(0);
	expect((await apply(plan)).state).toBe("completed");
	const labels = await links("First");
	expect(labels.map((row) => row.name).sort()).toEqual([
		"Home",
		"home",
		"work",
	]);
	expect(labels.every((row) => row.workspace_id === "content-target")).toBe(
		true,
	);
	expect(labels.find((row) => row.name === "home")).toMatchObject({
		id: "pre-home",
		color: "teal",
	});
	expect(await count("label")).toBe(4);
	expect(
		(
			await admin.query(
				"select count(*)::int n from task_label where label_id='foreign-work'",
			)
		).rows[0].n,
	).toBe(0);

	const again = await save({
		...first,
		source: { mode: "existing", id: first.source.id },
	});
	expect(again.report.counts.blocked).toBe(0);
	expect((await apply(again)).state).toBe("completed");
	expect(await count("label")).toBe(4);
	expect(await count("task")).toBe(1);
	expect(await count("task_label")).toBe(3);

	const second = await save(await body("generic-csv", csv("Second")));
	expect(second.report.counts.blocked).toBe(0);
	expect((await apply(second)).state).toBe("completed");
	expect(await count("label")).toBe(4);
	expect((await links("Second")).map((row) => row.id)).toEqual(
		labels.map((row) => row.id),
	);
});

test("import activation suppresses recent past-due notifications before the overdue candidate scan", async () => {
	const now = new Date(),
		due = new Date(now.getTime() - 3_600_000).toISOString();
	const value = await body(
		"generic-csv",
		Buffer.from(`id,title,due\nold,Imported overdue,${due}\n`),
	);
	const plan = await save(value);
	await apply(plan);
	const evidence = (
		await admin.query(
			"select t.due_at,r.overdue_suppressed_due_at,r.cutoff,r.active from task t join task_notification_recipient r on r.task_id=t.id where t.title='Imported overdue'",
		)
	).rows;
	expect(evidence).toHaveLength(1);
	expect(evidence[0].active).toBe(true);
	expect(evidence[0].overdue_suppressed_due_at).toEqual(evidence[0].due_at);
	expect(evidence[0].cutoff.getTime()).toBeGreaterThanOrEqual(now.getTime());
	const database = drizzle(admin, { schema: tables });
	expect(await overdueSweep(database, { now: new Date() })).toEqual({
		scanned: 0,
		enqueued: 0,
	});
	const list = (
		await admin.query(
			"select id from list where workspace_id='content-target' limit 1",
		)
	).rows[0].id;
	await admin.query(
		"insert into task(id,list_id,title,sort_key,due_at) values('content-positive-control',$1,'Ordinary overdue','a9',$2)",
		[list, due],
	);
	expect((await overdueSweep(database, { now: new Date() })).scanned).toBe(1);
	expect(await count("notification_outbox")).toBe(0);
});

test("Todoist identical bytes replan across days with the original source anchor and no duplicate tasks", async () => {
	for (const date of [
		"",
		"every day",
		"Oct 21",
		"every week starting Oct 21",
		"Feb 29",
	]) {
		const bytes = Buffer.from(
			`TYPE,CONTENT,DATE,DATE_LANG\ntask,Anchor ${date || "undated"},${date},en\n`,
		);
		const leap = date === "Feb 29";
		const firstAt = leap ? "2028-01-15T00:00:00.000Z" : options.exportedAt;
		const laterAt = leap
			? "2029-01-16T00:00:00.000Z"
			: "2027-01-16T00:00:00.000Z";
		const first = await body("todoist", bytes, randomUUID(), firstAt);
		const plan = await save(first);
		const later = await body("todoist", bytes, first.source.id, laterAt);
		expect(later.input.originalBase64).toBe(first.input.originalBase64);
		expect(first.input.anchorDay).toBe(date ? firstAt.slice(0, 10) : null);
		expect(later.input.anchorDay).toBe(
			date && !leap ? laterAt.slice(0, 10) : null,
		);
		const replan = await save({
			...later,
			source: { mode: "existing", id: first.source.id },
		});
		expect(replan.id).toBe(plan.id);
		expect(replan.documentDigest).toBe(plan.documentDigest);
		expect(replan.inputBinding).toEqual(plan.inputBinding);
		expect(replan.inputBinding.anchorDay).toBe(first.input.anchorDay);
		expect((await apply(replan)).state).toBe("completed");
		const before = (
			await admin.query("select id, due_at, rrule from task order by id")
		).rows;
		const retry = await save({
			...later,
			source: { mode: "existing", id: first.source.id },
		});
		expect(retry.documentDigest).toBe(plan.documentDigest);
		expect(retry.inputBinding).toEqual(plan.inputBinding);
		expect((await apply(retry)).state).toBe("completed");
		expect(
			(await admin.query("select id, due_at, rrule from task order by id"))
				.rows,
		).toEqual(before);
		const expectedDue = !date
			? null
			: leap
				? "2028-02-29T00:00:00.000Z"
				: date === "every day"
					? "2026-01-15T00:00:00.000Z"
					: "2026-10-21T00:00:00.000Z";
		expect(
			(
				await admin.query("select due_at from task where title=$1", [
					`Anchor ${date || "undated"}`,
				])
			).rows.map((row) => row.due_at?.toISOString() ?? null),
		).toEqual([expectedDue]);
	}
	expect(await count("task")).toBe(5);
	expect(await count("import_source")).toBe(5);
});
