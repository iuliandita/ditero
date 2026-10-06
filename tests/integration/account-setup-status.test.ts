import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from "vitest";
import { withUserContext } from "../../src/db/user-context.ts";
import type { AccountSetupOutcome } from "../../src/domain/account-setup.ts";
import { accountSetupStatusResponseSchema } from "../../src/domain/account-setup-status.ts";
import { accountSetupStoredStateSchema } from "../../src/domain/account-setup-storage.ts";
import { hashPAT } from "../../src/security/field-encryption.ts";
import { publicApiRoutes } from "../../src/server/public-api/routes.ts";
import {
	createPersonalAccessToken,
	revokePersonalAccessToken,
} from "../../src/server/public-api/tokens.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString });
const role = `setup_status_${randomUUID().replaceAll("-", "")}`;
const password = randomUUID();
const runtimeURL = new URL(connectionString);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({ connectionString: runtimeURL.href });
const app = publicApiRoutes(runtime, async () => true);
let alice: string;
let bob: string;
let users: string[] = [];
let aliceToken: string;
let bobToken: string;

beforeAll(async () => {
	const statement = await admin.query(
		"select format('create role %I login password %L nosuperuser nocreatedb nocreaterole noinherit nobypassrls',$1::text,$2::text) statement",
		[role, password],
	);
	await admin.query(statement.rows[0].statement);
	await admin.query(`grant usage on schema public to "${role}"`);
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	expect(
		(
			await runtime.query(
				"select current_user,session_user,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([
		{
			current_user: role,
			session_user: role,
			rolsuper: false,
			rolbypassrls: false,
		},
	]);
	expect(
		(
			await admin.query(
				"select relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) owner from pg_class where oid='account_setup'::regclass",
			)
		).rows,
	).toEqual([
		{
			relrowsecurity: true,
			relforcerowsecurity: true,
			owner: expect.not.stringMatching(`^${role}$`),
		},
	]);
});
beforeEach(async () => {
	[alice, bob] = [randomUUID(), randomUUID()];
	users = [alice, bob];
	for (const id of users)
		await admin.query(
			'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
			[id, "Status fixture", `${id}@setup-status.test`],
		);
	aliceToken = (
		await createPersonalAccessToken(runtime, alice, { name: "status read" })
	).token;
	bobToken = (
		await createPersonalAccessToken(runtime, bob, { name: "other status read" })
	).token;
});
afterEach(async () => {
	await admin.query(
		"delete from managed_account where user_id=any($1::text[]) or guardian_id=any($1::text[])",
		[users],
	);
	await admin.query(
		"delete from task where list_id in (select id from list where owner_id=any($1::text[]))",
		[users],
	);
	await admin.query("delete from list where owner_id=any($1::text[])", [users]);
	await admin.query("delete from dashboard where owner_id=any($1::text[])", [
		users,
	]);
	await admin.query(
		"delete from membership where workspace_id in (select id from workspace where owner_id=any($1::text[]))",
		[users],
	);
	await admin.query("delete from workspace where owner_id=any($1::text[])", [
		users,
	]);
	await admin.query('delete from "user" where id=any($1::text[])', [users]);
});
afterAll(async () => {
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});
function request(secret: string | null = aliceToken, suffix = "") {
	return app.handle(
		new Request(`http://localhost/api/v1/setup-status${suffix}`, {
			headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
		}),
	);
}
async function snapshot() {
	return (
		await admin.query(
			`select
 (select jsonb_agg(to_jsonb(s) order by s.id) from account_setup s where s.id=any($1::text[])) setup,
 (select jsonb_agg(to_jsonb(w) order by w.id) from workspace w where w.owner_id=any($1::text[])) workspaces,
 (select jsonb_agg(to_jsonb(m) order by m.id) from membership m where m.user_id=any($1::text[])) memberships,
 (select jsonb_agg(to_jsonb(l) order by l.id) from list l where l.owner_id=any($1::text[])) lists,
 (select jsonb_agg(to_jsonb(t) order by t.id) from task t join list l on l.id=t.list_id where l.owner_id=any($1::text[])) tasks,
 (select jsonb_agg(to_jsonb(d) order by d.id) from dashboard d where d.owner_id=any($1::text[])) dashboards,
 (select jsonb_agg(to_jsonb(p) order by p.id) from user_pref p where p.id=any($1::text[])) preferences,
 (select jsonb_agg(to_jsonb(m) order by m.id) from managed_account m where m.user_id=any($1::text[]) or m.guardian_id=any($1::text[])) managed`,
			[users],
		)
	).rows[0];
}
async function readUnchanged(
	outcome: AccountSetupOutcome,
	revision: number,
	eligibility: "available" | "managed" = "available",
	secret = aliceToken,
) {
	const before = await snapshot();
	const response = await request(secret);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("application/json");
	expect(response.headers.get("cache-control")).toBe("no-store");
	const body: unknown = await response.json();
	expect(accountSetupStatusResponseSchema.safeParse(body).success).toBe(true);
	// Literal public contract: no receipt, request, generated IDs, email, or caller ID.
	expect(body).toEqual({
		version: 1,
		data: {
			outcome,
			revision,
			eligibility,
			catalogVersion: 1,
			setupPath: "/setup",
		},
		nextCursor: null,
	});
	expect(await snapshot()).toEqual(before);
	return JSON.stringify(body);
}
async function seed(outcome: AccountSetupOutcome, userId = alice) {
	const quiet = outcome === "pending" || outcome === "legacy";
	const mode =
		outcome === "custom" ? "custom" : outcome === "skipped" ? "skip" : "basic";
	const stored = accountSetupStoredStateSchema.parse({
		state: {
			outcome,
			revision: quiet ? 0 : 1,
			receipt: quiet
				? null
				: {
						request: {
							requestId: randomUUID(),
							expectedRevision: 0,
							catalogVersion: 1,
							locale: "ro",
							mode,
						},
						outcome,
						revision: 1,
					},
		},
		catalogVersion: quiet ? null : 1,
		locale: quiet ? null : "ro",
		generatedIds:
			outcome === "completed"
				? {
						version: 1,
						workspaceId: randomUUID(),
						listIds: Array.from({ length: 2 }, () => randomUUID()),
						taskIds: Array.from({ length: 16 }, () => randomUUID()),
						panelIds: [randomUUID(), randomUUID()],
						dashboardId: randomUUID(),
					}
				: null,
	});
	// Seed codec-valid persisted metadata, with content absent as after a deletion.
	await admin.query(
		"insert into account_setup(id,outcome,revision,catalog_version,locale,latest_receipt,generated_ids) values($1,$2,$3,$4,$5,$6,$7)",
		[
			userId,
			stored.state.outcome,
			stored.state.revision,
			stored.catalogVersion,
			stored.locale,
			stored.state.receipt === null
				? null
				: JSON.stringify(stored.state.receipt),
			stored.generatedIds === null ? null : JSON.stringify(stored.generatedIds),
		],
	);
	return stored;
}

test("an absent own row reports pending without bootstrapping setup or workspace content", async () => {
	await seed("completed", bob);
	expect(
		await withUserContext(
			runtime,
			alice,
			async (client) =>
				(await client.query("select id from account_setup")).rows,
		),
	).toEqual([]);
	await readUnchanged("pending", 0);
	expect(
		(await admin.query("select id from account_setup where id=$1", [alice]))
			.rows,
	).toEqual([]);
});
test.each([
	"pending",
	"legacy",
] as const)("stored %s remains quiet after repeated status reads", async (outcome) => {
	await seed(outcome);
	await readUnchanged(outcome, 0);
	await readUnchanged(outcome, 0);
});
test.each([
	"custom",
	"skipped",
	"completed",
] as const)("%s reports only bounded public status without repairing absent content", async (outcome) => {
	const stored = await seed(outcome);
	const text = await readUnchanged(outcome, 1);
	expect(text.length).toBeLessThan(256);
	expect(text).not.toContain(stored.state.receipt?.request.requestId);
	if (stored.generatedIds)
		for (const id of [
			stored.generatedIds.workspaceId,
			...stored.generatedIds.taskIds,
		])
			expect(text).not.toContain(id);
});
test.each([
	true,
	false,
])("any own managed marker blocks eligibility when restricted=%s; guardian stays available", async (restricted) => {
	await admin.query(
		"insert into managed_account(id,user_id,guardian_id,restricted) values($1,$2,$3,$4)",
		[randomUUID(), alice, bob, restricted],
	);
	await readUnchanged("pending", 0, "managed");
	await readUnchanged("pending", 0, "available", bobToken);
});
test("reserved email blocks eligibility before any managed marker exists", async () => {
	await admin.query('update "user" set email=$2 where id=$1', [
		alice,
		`${randomUUID()}@managed.invalid`,
	]);
	expect(
		(
			await admin.query("select id from managed_account where user_id=$1", [
				alice,
			])
		).rows,
	).toEqual([]);
	await readUnchanged("pending", 0, "managed");
});
test("two distinct PAT owners read their own positive status and no private foreign fields", async () => {
	const first = await seed("custom", alice);
	const second = await seed("completed", bob);
	for (const [owner, foreign, secret, outcome] of [
		[alice, bob, aliceToken, "custom"],
		[bob, alice, bobToken, "completed"],
	] as const) {
		expect(
			await withUserContext(
				runtime,
				owner,
				async (client) =>
					(await client.query("select id from account_setup order by id")).rows,
			),
		).toEqual([{ id: owner }]);
		const text = await readUnchanged(outcome, 1, "available", secret);
		for (const hidden of [
			owner,
			foreign,
			`${foreign}@setup-status.test`,
			first.state.receipt?.request.requestId,
			second.state.receipt?.request.requestId,
			second.generatedIds?.workspaceId,
		]) {
			if (!hidden) throw new Error("Private fixture field missing");
			expect(text).not.toContain(hidden);
		}
	}
});
test.each([
	"?userId=foreign",
	"?limit=1",
	"?cursor=anything",
	"?extra=",
])("query parameters %s refuse without writes", async (suffix) => {
	const before = await snapshot();
	const response = await request(aliceToken, suffix);
	expect(response.status).toBe(400);
	expect(await response.json()).toMatchObject({ code: "invalid-query" });
	expect(await snapshot()).toEqual(before);
});
test("missing, revoked, expired, and deleted-owner PATs refuse setup discovery without writes", async () => {
	const revoked = await createPersonalAccessToken(runtime, alice, {
		name: "revoked",
	});
	await revokePersonalAccessToken(runtime, alice, revoked.id);
	const expired = await createPersonalAccessToken(runtime, alice, {
		name: "expired",
	});
	await admin.query(
		"update personal_access_token set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where token_hash=$1",
		[hashPAT(expired.token)],
	);
	await admin.query('update "user" set deleted_at=now() where id=$1', [bob]);
	const before = await snapshot();
	for (const secret of [null, revoked.token, expired.token, bobToken]) {
		const response = await request(secret);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ code: "unauthorized" });
	}
	expect(await snapshot()).toEqual(before);
});
test("structurally bounded but codec-invalid stored metadata refuses rather than exposing a status", async () => {
	const stored = await seed("completed");
	if (!stored.generatedIds) throw new Error("Completed fixture IDs missing");
	await admin.query("update account_setup set generated_ids=$2 where id=$1", [
		alice,
		JSON.stringify({
			...stored.generatedIds,
			taskIds: [stored.generatedIds.workspaceId],
		}),
	]);
	const before = await snapshot();
	const response = await request();
	expect(response.status).toBe(500);
	expect(await response.json()).toMatchObject({ code: "invalid-setup-state" });
	expect(await snapshot()).toEqual(before);
});
