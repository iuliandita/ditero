// #1173: a password reset takes back every credential someone holding the old
// password could have planted, in the same transaction as the reset itself.
// The auth handler runs as a restricted runtime role, so the row-level
// security on tokens and feeds is really in force.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
	vi,
} from "vitest";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const admin = new Pool({ connectionString });
const role = `reset_revocation_${randomUUID().replaceAll("-", "")}`;
const password = randomUUID();
const runtimeURL = new URL(connectionString);
runtimeURL.username = role;
runtimeURL.password = password;
const runtime = new Pool({ connectionString: runtimeURL.href });
const origin = "http://localhost:3000";

let auth: typeof import("../../src/auth/auth.ts");
let tokens: typeof import("../../src/server/public-api/tokens.ts");
let feeds: typeof import("../../src/server/public-api/calendar-feeds.ts");
let users: string[] = [];

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
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ rolsuper: false, rolbypassrls: false }]);
	for (const table of ["personal_access_token", "calendar_feed"])
		expect(
			(
				await admin.query(
					"select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass",
					[table],
				)
			).rows,
		).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
	// The shared app client reads DATABASE_URL when it is first imported.
	process.env.DATABASE_URL = runtimeURL.href;
	auth = await import("../../src/auth/auth.ts");
	tokens = await import("../../src/server/public-api/tokens.ts");
	feeds = await import("../../src/server/public-api/calendar-feeds.ts");
});

beforeEach(async () => {
	await admin.query("delete from rate_limit");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await admin.query(
		`grant select,insert,update,delete on all tables in schema public to "${role}"`,
	);
	await admin.query("delete from list where owner_id=any($1::text[])", [users]);
	await admin.query("delete from membership where user_id=any($1::text[])", [
		users,
	]);
	await admin.query("delete from workspace where owner_id=any($1::text[])", [
		users,
	]);
	await admin.query('delete from "user" where id=any($1::text[])', [users]);
	users = [];
});

afterAll(async () => {
	process.env.DATABASE_URL = connectionString;
	await runtime.end();
	await admin.end();
	const cleanup = new Pool({ connectionString });
	await cleanup.query(`drop owned by "${role}"`);
	await cleanup.query(`drop role "${role}"`);
	await cleanup.end();
});

const hex = () => createHash("sha256").update(randomBytes(16)).digest("hex");

async function seedAccount() {
	const userId = randomUUID();
	const workspaceId = randomUUID();
	const listId = randomUUID();
	users.push(userId);
	const context = await auth.auth.$context;
	await admin.query(
		'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
		[userId, "Reset fixture", `${userId}@reset.test`],
	);
	await admin.query(
		"insert into account(id,account_id,provider_id,user_id,password,updated_at) values($1,$2,'credential',$2,$3,now())",
		[randomUUID(), userId, await context.password.hash("old-password-123")],
	);
	await admin.query(
		"insert into workspace(id,name,owner_id,kind) values($1,'Personal',$2,'personal')",
		[workspaceId, userId],
	);
	await admin.query(
		"insert into membership(id,workspace_id,user_id,role) values($1,$2,$3,'owner')",
		[randomUUID(), workspaceId, userId],
	);
	await admin.query(
		"insert into list(id,workspace_id,owner_id,title,kind,sort_key) values($1,$2,$3,'Chores','tasks','a0')",
		[listId, workspaceId, userId],
	);
	await admin.query(
		"insert into session(id,token,user_id,expires_at,updated_at) values($1,$2,$3,now()+interval '1 day',now())",
		[randomUUID(), randomUUID(), userId],
	);
	const token = (
		await tokens.createPersonalAccessToken(runtime, userId, {
			name: "planted",
			access: "write",
		})
	).token;
	const feed = (
		await feeds.createCalendarFeed(runtime, userId, { name: "planted", listId })
	).secret;
	await admin.query(
		"insert into passkey(id,name,public_key,user_id,credential_id,counter,device_type,backed_up) values($1,'planted','key',$2,$3,0,'singleDevice',false)",
		[randomUUID(), userId, randomUUID()],
	);
	await admin.query(
		"insert into account(id,account_id,provider_id,user_id,updated_at) values($1,$2,'google',$3,now())",
		[randomUUID(), randomUUID(), userId],
	);
	await admin.query(
		"insert into two_factor(id,secret,backup_codes,user_id) values($1,'secret','codes',$2)",
		[randomUUID(), userId],
	);
	await admin.query(
		"insert into inbound_webhook(id,user_id,list_id,workspace_id,name,secret_hash,hint,expires_at) values($1,$2,$3,$4,'kept',$5,'abcd',now()+interval '30 days')",
		[randomUUID(), userId, listId, workspaceId, hex()],
	);
	const resetToken = randomBytes(24).toString("hex");
	await admin.query(
		"insert into verification(id,identifier,value,expires_at,updated_at) values($1,$2,$3,now()+interval '1 hour',now())",
		[randomUUID(), `reset-password:${resetToken}`, userId],
	);
	return { userId, token, feed, resetToken };
}

function reset(token: string, newPassword = "new-password-456") {
	return auth.handleAuthRequest(
		new Request(`${origin}/api/auth/reset-password`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({ newPassword, token }),
		}),
	);
}

async function counts(userId: string) {
	const { rows } = await admin.query(
		`select
			(select count(*)::int from session where user_id=$1) sessions,
			(select count(*)::int from personal_access_token where user_id=$1 and revoked_at is null) "accessTokens",
			(select count(*)::int from calendar_feed where user_id=$1 and revoked_at is null) "calendarFeeds",
			(select count(*)::int from passkey where user_id=$1) passkeys,
			(select count(*)::int from account where user_id=$1 and provider_id<>'credential') "linkedAccounts",
			(select count(*)::int from account where user_id=$1 and provider_id='credential') credentials,
			(select count(*)::int from two_factor where user_id=$1) "twoFactor",
			(select count(*)::int from inbound_webhook where user_id=$1 and revoked_at is null) webhooks,
			(select count(*)::int from verification where identifier like 'reset-password:%' and value=$1) "resetTokens"`,
		[userId],
	);
	return rows[0];
}

async function passwordMatches(userId: string, candidate: string) {
	const { rows } = await admin.query(
		"select password from account where user_id=$1 and provider_id='credential'",
		[userId],
	);
	return (await auth.auth.$context).password.verify({
		hash: rows[0].password,
		password: candidate,
	});
}

test("a reset revokes planted credentials and reports them, leaving workspace secrets and two-factor", async () => {
	const victim = await seedAccount();
	const bystander = await seedAccount();

	const response = await reset(victim.resetToken);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(await response.json()).toEqual({
		status: true,
		revoked: {
			accessTokens: 1,
			calendarFeeds: 1,
			passkeys: 1,
			linkedAccounts: 1,
		},
	});

	expect(await counts(victim.userId)).toEqual({
		sessions: 0,
		accessTokens: 0,
		calendarFeeds: 0,
		passkeys: 0,
		linkedAccounts: 0,
		credentials: 1,
		twoFactor: 1,
		webhooks: 1,
		resetTokens: 0,
	});
	expect(await passwordMatches(victim.userId, "new-password-456")).toBe(true);
	await expect(
		tokens.withPersonalAccessToken(
			runtime,
			victim.token,
			"read",
			async () => 1,
		),
	).rejects.toThrow();
	await expect(
		feeds.downloadCalendarFeed(runtime, victim.feed),
	).rejects.toThrow();

	expect(await counts(bystander.userId)).toMatchObject({
		sessions: 1,
		accessTokens: 1,
		calendarFeeds: 1,
		passkeys: 1,
		linkedAccounts: 1,
	});
	expect(
		await tokens.withPersonalAccessToken(
			runtime,
			bystander.token,
			"read",
			async () => "still valid",
		),
	).toBe("still valid");
});

test("a revocation failure rolls the whole reset back and leaves the link usable", async () => {
	const victim = await seedAccount();
	const before = await counts(victim.userId);
	vi.spyOn(console, "error").mockImplementation(() => {});
	await admin.query(`revoke update on calendar_feed from "${role}"`);

	const failed = await reset(victim.resetToken);
	expect(failed.ok).toBe(false);
	expect(await counts(victim.userId)).toEqual(before);
	expect(await passwordMatches(victim.userId, "old-password-123")).toBe(true);

	await admin.query(`grant update on calendar_feed to "${role}"`);
	const retried = await reset(victim.resetToken);
	expect(retried.status, await retried.clone().text()).toBe(200);
	expect(await counts(victim.userId)).toMatchObject({
		sessions: 0,
		accessTokens: 0,
		calendarFeeds: 0,
		resetTokens: 0,
	});
});

test("an invalid or spent token changes nothing", async () => {
	const victim = await seedAccount();
	const before = await counts(victim.userId);
	const wrong = await reset(randomBytes(24).toString("hex"));
	expect(wrong.status).toBe(400);
	expect(await wrong.json()).toMatchObject({ code: "INVALID_TOKEN" });
	expect(await counts(victim.userId)).toEqual(before);

	expect((await reset(victim.resetToken)).status).toBe(200);
	const replay = await reset(victim.resetToken, "another-password-789");
	expect(replay.status).toBe(400);
	expect(await passwordMatches(victim.userId, "new-password-456")).toBe(true);
});

test("a reset that bypasses the revoking entry point is refused", async () => {
	const victim = await seedAccount();
	const before = await counts(victim.userId);
	const direct = await auth.auth.handler(
		new Request(`${origin}/api/auth/reset-password`, {
			method: "POST",
			headers: { "content-type": "application/json", origin },
			body: JSON.stringify({
				newPassword: "new-password-456",
				token: victim.resetToken,
			}),
		}),
	);
	expect(direct.status).toBe(500);
	expect(await direct.json()).toMatchObject({ code: "RESET_UNAVAILABLE" });
	expect(await counts(victim.userId)).toEqual(before);
});
