import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Elysia } from "elysia";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { buildImportPlan } from "../../src/domain/portability/import-plan.ts";
import {
	CSV_V1_EXCLUSIONS,
	prepareProviderImport,
	providerDocumentDigest,
} from "../../src/domain/portability/providers/input.ts";
import { makeGuards, type Session } from "../../src/server/guards.ts";
import { importPlanRoutes } from "../../src/server/portability/import-routes.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString: url });
const runtime = new Pool({
	connectionString: url,
	application_name: "ditero-csv-public-test",
});
const role = "ditero_csv_public_test";
const namespace = "fcb28f31-12ae-4c9d-82f2-1289d9fcb411";
const fixture = readFileSync(
	new URL("../fixtures/portability/providers/csv-v1.csv", import.meta.url),
);
const guards = makeGuards(["http://localhost"], async (headers) =>
	headers.get("x-user")
		? ({ user: { id: headers.get("x-user") } } as Session)
		: null,
);
const app = new Elysia().use(importPlanRoutes(runtime, guards));
const input = (bytes: Uint8Array = fixture, sourceNamespace = namespace) => ({
	kind: "provider",
	version: 1,
	adapter: "ditero-csv",
	adapterVersion: 1,
	sourceNamespace,
	identityMode: "stable-ids",
	exclusions: [...CSV_V1_EXCLUSIONS],
	originalCsvBase64: Buffer.from(bytes).toString("base64"),
});
function body(
	bytes: Uint8Array = fixture,
	id = randomUUID(),
	sourceNamespace = namespace,
) {
	const provider = prepareProviderImport(input(bytes, sourceNamespace), {
		exportedAt: "2026-01-15T00:00:00.000Z",
	});
	return {
		source: { mode: "new", id, label: "CSV source" },
		input: input(bytes, sourceNamespace),
		mappings: {
			workspaces: {
				[provider.conversion.document.data.workspaces[0].id]: "csv-target",
			},
			principals: { [provider.conversion.document.sourceUserId]: "csv-owner" },
		},
	};
}
function request(path: string, value?: unknown, actor = "csv-owner") {
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
async function save(value = body()) {
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
beforeAll(async () => {
	await admin.query(
		`do $$ begin if not exists(select from pg_roles where rolname='${role}') then create role ${role} nosuperuser nocreatedb nocreaterole noinherit nobypassrls; end if; end $$`,
	);
	await admin.query(`grant usage on schema public to ${role}`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to ${role}`,
	);
	runtime.on("connect", (client) => void client.query(`set role ${role}`));
});
beforeEach(async () => {
	await resetAuthFixture(admin);
	await admin.query(
		`insert into "user"(id,name,email,email_verified) values('csv-owner','Owner','csv-owner@example.test',false),('csv-outsider','Outside','csv-outside@example.test',false)`,
	);
	await admin.query(
		`insert into workspace(id,name,owner_id,kind) values('csv-target','Target','csv-owner','shared')`,
	);
	await admin.query(
		`insert into membership(id,user_id,workspace_id,role) values('csv-seat','csv-owner','csv-target','owner')`,
	);
});
afterAll(async () => {
	await runtime.end();
	await admin.end();
});
test("real restricted role seals CSV metadata and applies stable IDs without historical or notification effects", async () => {
	const value = body();
	const plan = await save(value);
	expect(
		(
			await runtime.query(
				"select current_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ current_user: role, rolsuper: false, rolbypassrls: false }]);
	expect(plan.report).toMatchObject({
		plannerVersion: 4,
		applySupported: true,
	});
	const prepared = prepareProviderImport(value.input, {
		exportedAt: "2026-04-01T00:00:00.000Z",
	});
	const ordinary = await buildImportPlan(prepared.conversion.document, {
		ownerUserId: "csv-owner",
		sourceId: value.source.id,
		mappings: value.mappings,
	});
	expect(plan.documentDigest).toBe(
		await providerDocumentDigest(prepared.binding, ordinary.documentDigest),
	);
	expect(plan.documentDigest).not.toBe(ordinary.documentDigest);
	expect(plan.inputBinding).toEqual(prepared.binding);
	expect(
		(await admin.query("select format,input_binding from import_source")).rows,
	).toEqual([{ format: "ditero-csv", input_binding: prepared.binding }]);
	expect((await apply(plan)).state).toBe("completed");
	expect(
		(await admin.query("select title from task order by title")).rows,
	).toEqual([{ title: "Buy apples" }, { title: "Prepare groceries" }]);
	for (const table of [
		"task_completion_event",
		"imported_completion_event",
		"karma_event",
		"notification_outbox",
		"reminder_state",
		"task_assignee",
	])
		expect(
			(await admin.query(`select count(*)::int as n from ${table}`)).rows[0].n,
		).toBe(0);
	expect((await apply(plan)).state).toBe("completed");
	const lines = fixture.toString().trimEnd().split("\n");
	const reordered = body(
		Buffer.from(`${[lines[0], ...lines.slice(1).reverse()].join("\n")}\n`),
		value.source.id,
	);
	const replay = await save(reordered);
	expect(replay.documentDigest).toBe(plan.documentDigest);
	expect((await apply(replay)).state).toBe("completed");
	expect(
		(await admin.query("select count(*)::int as n from task")).rows[0].n,
	).toBe(2);
});
test("source identity cannot switch namespace, policy, provider or native format", async () => {
	const value = body();
	await save(value);
	const altered = fixture
		.toString()
		.replaceAll(namespace, "11111111-1111-4111-8111-111111111111");
	const changed = body(
		Buffer.from(altered),
		value.source.id,
		"11111111-1111-4111-8111-111111111111",
	);
	changed.input.sourceNamespace = "11111111-1111-4111-8111-111111111111";
	const rebound = await request("plans", changed);
	expect(rebound.status).toBe(409);
	expect(await rebound.json()).toEqual({ code: "source-binding-conflict" });
	const { input: _input, ...native } = value;
	const provider = prepareProviderImport(value.input, {
		exportedAt: "2026-01-15T00:00:00.000Z",
	});
	expect(
		(
			await request("plans", {
				...native,
				document: JSON.stringify(provider.conversion.document),
			})
		).status,
	).toBe(409);
	const policy = body(fixture, value.source.id);
	policy.input.exclusions.reverse();
	expect((await request("plans", policy)).status).toBe(400);
	expect(
		(await admin.query("select count(*)::int as n from import_job")).rows[0].n,
	).toBe(1);
});
test("job/source binding updates and forged cross-binding inserts cannot pass database proof", async () => {
	const plan = await save();
	for (const table of ["import_source", "import_job"]) {
		await expect(
			admin.query(`update ${table} set input_binding=null`),
		).rejects.toMatchObject({ code: "23514" });
		await expect(
			admin.query(
				`update ${table} set input_binding=jsonb_set(input_binding,'{identityMode}','"snapshot"')`,
			),
		).rejects.toMatchObject({ code: "23514" });
	}
	const client = await runtime.connect();
	try {
		await client.query("begin");
		await client.query("set local ditero.user_id='csv-owner'");
		await expect(
			client.query(
				"insert into import_job(id,source_id,owner_user_id,document_digest,mapping_digest,plan_digest,report,payload_bytes,planner_version,apply_supported,input_binding) select $1,source_id,owner_user_id,document_digest,mapping_digest,$1,report,payload_bytes,planner_version,apply_supported,null from import_job where id=$2",
				["f".repeat(64), plan.id],
			),
		).rejects.toMatchObject({ code: "23514" });
	} finally {
		await client.query("rollback");
		client.release();
	}
});
test("tampered confirmation and outsider access cannot apply the saved CSV plan", async () => {
	const plan = await save();
	expect(
		(
			await request(`plans/${plan.id}/apply`, {
				planDigest: "f".repeat(64),
				counts: plan.report.counts,
			})
		).status,
	).toBe(409);
	expect(
		(await request(`plans/${plan.id}`, undefined, "csv-outsider")).status,
	).toBe(404);
	expect(
		(
			await request(
				`plans/${plan.id}/apply`,
				{ planDigest: plan.planDigest, counts: plan.report.counts },
				"csv-outsider",
			)
		).status,
	).toBe(404);
	expect(
		(await admin.query("select count(*)::int as n from task")).rows[0].n,
	).toBe(0);
});
test("native ordinary import keeps NULL binding and existing digest semantics", async () => {
	const value = body();
	const prepared = prepareProviderImport(value.input, {
		exportedAt: "2026-01-15T00:00:00.000Z",
	});
	const { input: _input, ...native } = value;
	const response = await request("plans", {
		...native,
		document: JSON.stringify(prepared.conversion.document),
	});
	expect(response.status).toBe(200);
	const plan = await response.json();
	expect(plan.inputBinding).toBeNull();
	const ordinary = await buildImportPlan(prepared.conversion.document, {
		ownerUserId: "csv-owner",
		sourceId: value.source.id,
		mappings: value.mappings,
	});
	expect(plan.documentDigest).toBe(ordinary.documentDigest);
	expect(
		(await admin.query("select input_binding from import_source")).rows,
	).toEqual([{ input_binding: null }]);
	expect((await apply(plan)).state).toBe("completed");
});

test("database binding shape rejects forged UUID variants and extra metadata under the restricted role", async () => {
	const binding = prepareProviderImport(input(), {
		exportedAt: "2026-01-15T00:00:00.000Z",
	}).binding;
	for (const altered of [
		{ ...binding, sourceNamespace: "11111111-1111-0111-0111-111111111111" },
		{ ...binding, extra: true },
		{ ...binding, exclusions: [...binding.exclusions].reverse() },
	]) {
		const client = await runtime.connect();
		try {
			await client.query("begin");
			await client.query("set local ditero.user_id='csv-owner'");
			await expect(
				client.query(
					"insert into import_source(id,owner_user_id,label,format,schema_version,source_user_id,input_binding) values($1,'csv-owner','Forged','ditero-csv',1,$2,$3::jsonb)",
					[
						randomUUID(),
						`migration:ditero-csv:1:${altered.sourceNamespace}:owner`,
						JSON.stringify(altered),
					],
				),
			).rejects.toMatchObject({ code: "23514" });
		} finally {
			await client.query("rollback");
			client.release();
		}
	}
});
