// #1173: a password reset takes back every credential someone holding the old
// password could have planted, in the same transaction as the reset itself.
// The auth handler runs as a restricted runtime role, so the row-level
// security on tokens and feeds is really in force.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
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
let appPool: typeof import("../../src/db/client.ts")["pool"] | undefined;
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
	({ pool: appPool } = await import("../../src/db/client.ts"));
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
	await appPool?.end();
	await runtime.end();
	await admin.query(`drop owned by "${role}"`);
	await admin.query(`drop role "${role}"`);
	await admin.end();
});

const hex = () => createHash("sha256").update(randomBytes(16)).digest("hex");

async function seedAccount({ withPassword = true } = {}) {
	const userId = randomUUID();
	const workspaceId = randomUUID();
	const listId = randomUUID();
	users.push(userId);
	const context = await auth.auth.$context;
	await admin.query(
		'insert into "user"(id,name,email,email_verified) values($1,$2,$3,true)',
		[userId, "Reset fixture", `${userId}@reset.test`],
	);
	if (withPassword)
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
	const [resetToken, otherResetToken] = [0, 1].map(() =>
		randomBytes(24).toString("hex"),
	);
	for (const value of [resetToken, otherResetToken])
		await admin.query(
			"insert into verification(id,identifier,value,expires_at,updated_at) values($1,$2,$3,now()+interval '1 hour',now())",
			[randomUUID(), `reset-password:${value}`, userId],
		);
	return { userId, token, feed, resetToken, otherResetToken };
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
	expect((await reset(victim.otherResetToken)).status).toBe(400);

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

test("a reset of a provider-only account creates its password and unlinks the provider", async () => {
	const victim = await seedAccount({ withPassword: false });
	const response = await reset(victim.resetToken);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(await response.json()).toMatchObject({
		revoked: { linkedAccounts: 1, accessTokens: 1 },
	});
	expect(await counts(victim.userId)).toMatchObject({
		credentials: 1,
		linkedAccounts: 0,
		accessTokens: 0,
		resetTokens: 0,
	});
	expect(await passwordMatches(victim.userId, "new-password-456")).toBe(true);
});

test("a reset succeeds even when there are no planted credentials or sessions", async () => {
	const victim = await seedAccount();
	for (const table of [
		"session",
		"personal_access_token",
		"calendar_feed",
		"passkey",
	])
		await admin.query(`delete from ${table} where user_id=$1`, [victim.userId]);
	await admin.query(
		"delete from account where user_id=$1 and provider_id<>'credential'",
		[victim.userId],
	);
	const response = await reset(victim.resetToken);
	expect(response.status, await response.clone().text()).toBe(200);
	expect(await response.json()).toEqual({
		status: true,
		revoked: {
			accessTokens: 0,
			calendarFeeds: 0,
			passkeys: 0,
			linkedAccounts: 0,
		},
	});
	expect(await passwordMatches(victim.userId, "new-password-456")).toBe(true);
});

test("concurrent uses of one reset link have exactly one winner", async () => {
	const victim = await seedAccount();
	const responses = await Promise.all([
		reset(victim.resetToken, "first-password-123"),
		reset(victim.resetToken, "second-password-456"),
	]);
	expect(responses.map((response) => response.status).sort()).toEqual([
		200, 400,
	]);
	const winner = responses[0].ok ? "first-password-123" : "second-password-456";
	expect(await passwordMatches(victim.userId, winner)).toBe(true);
	expect(await counts(victim.userId)).toMatchObject({
		resetTokens: 0,
		accessTokens: 0,
	});
});

function postAuth(path: string, body: unknown, cookie = "") {
	return auth.handleAuthRequest(
		new Request(`${origin}/api/auth${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", origin, cookie },
			body: JSON.stringify(body),
		}),
	);
}

const cookies = (response: Response) =>
	response.headers
		.getSetCookie()
		.map((value) => value.split(";")[0])
		.join("; ");

test("a pending password sign-in cannot finish TOTP after a reset", async () => {
	const victim = await seedAccount();
	await admin.query("delete from two_factor where user_id=$1", [victim.userId]);
	const signIn = () =>
		postAuth("/sign-in/email", {
			email: `${victim.userId}@reset.test`,
			password: "old-password-123",
		});
	const session = await signIn();
	expect(session.status).toBe(200);
	const enabled = await postAuth(
		"/two-factor/enable",
		{
			password: "old-password-123",
			method: "totp",
		},
		cookies(session),
	);
	expect(enabled.status).toBe(200);
	const context = await auth.auth.$context;
	const enrolled = await context.adapter.findOne<{
		secret: string;
		backupCodes: string;
	}>({
		model: "twoFactor",
		where: [{ field: "userId", value: victim.userId }],
	});
	if (!enrolled) throw new Error("missing enrollment");
	const secret = await symmetricDecrypt({
		key: context.secretConfig,
		data: enrolled.secret,
	});
	const code = () => auth.auth.api.generateTOTP({ body: { secret } });
	const verified = await postAuth(
		"/two-factor/verify-totp",
		await code(),
		cookies(session),
	);
	expect(verified.status).toBe(200);
	// Establish a real trusted device, then a separate pending challenge.
	const trustedChallenge = await signIn();
	expect(await trustedChallenge.json()).toMatchObject({
		twoFactorRedirect: true,
	});
	const trusted = await postAuth(
		"/two-factor/verify-totp",
		{ ...(await code()), trustDevice: true },
		cookies(trustedChallenge),
	);
	expect(trusted.status).toBe(200);
	const pending = await signIn();
	expect(await pending.json()).toMatchObject({ twoFactorRedirect: true });
	const proofCount = async () =>
		(
			await admin.query(
				"select count(*)::int n from verification where value=$1 and (identifier like '2fa-%' or identifier like 'trust-device-%')",
				[victim.userId],
			)
		).rows[0].n;
	expect(await proofCount()).toBeGreaterThanOrEqual(2);
	expect((await reset(victim.resetToken)).status).toBe(200);
	expect((await counts(victim.userId)).sessions).toBe(0);
	const refused = await postAuth(
		"/two-factor/verify-totp",
		await code(),
		cookies(pending),
	);
	expect(refused.status).toBe(401);
	expect(await refused.json()).toMatchObject({
		code: "INVALID_TWO_FACTOR_COOKIE",
	});
	expect((await counts(victim.userId)).sessions).toBe(0);
	expect(
		await auth.auth.api.getSession({
			headers: new Headers({ cookie: cookies(refused) }),
		}),
	).toBeNull();
	expect(await proofCount()).toBe(0);
	const kept = await context.adapter.findOne<{
		secret: string;
		backupCodes: string;
	}>({
		model: "twoFactor",
		where: [{ field: "userId", value: victim.userId }],
	});
	// Do not include the enrolled secrets in assertion output.
	expect(
		kept?.secret === enrolled.secret &&
			kept?.backupCodes === enrolled.backupCodes,
	).toBe(true);
	const next = await postAuth(
		"/sign-in/email",
		{
			email: `${victim.userId}@reset.test`,
			password: "new-password-456",
		},
		cookies(trusted),
	);
	expect(await next.json()).toMatchObject({ twoFactorRedirect: true });
	const recovered = await postAuth(
		"/two-factor/verify-totp",
		await code(),
		cookies(next),
	);
	expect(recovered.status).toBe(200);
	expect((await counts(victim.userId)).sessions).toBe(1);
	expect(
		(
			await auth.auth.api.getSession({
				headers: new Headers({ cookie: cookies(recovered) }),
			})
		)?.user.id,
	).toBe(victim.userId);
});

test("a reset removes every account-bound verification format without touching a bystander", async () => {
	const victim = await seedAccount();
	const bystander = await seedAccount();
	const records = (userId: string) => {
		const challenge = `2fa-${randomUUID()}`;
		const email = `${userId}@reset.test`;
		return [
			[challenge, userId],
			[`2fa-attempts-${challenge}`, "0"],
			[`2fa-otp-${challenge}`, "opaque:0"],
			[`2fa-otp-${userId}`, "opaque:0"],
			[`trust-device-${randomUUID()}`, userId],
			[`delete-account-${randomUUID()}`, userId],
			[`sign-in-otp-${email}`, "opaque:0"],
			[`email-verification-otp-${email}`, "opaque:0"],
			[`forget-password-otp-${email}`, "opaque:0"],
			[
				`magic-link:${randomUUID()}`,
				JSON.stringify({ type: "magic-link", email }),
			],
			[
				randomUUID(),
				JSON.stringify({ type: "registration", userData: { id: userId } }),
			],
			[
				randomUUID(),
				JSON.stringify({ type: "authentication", userData: { id: userId } }),
			],
			[
				`auth-state:${randomUUID()}`,
				JSON.stringify({ link: { userId, email } }),
			],
		];
	};
	const own = records(victim.userId);
	const other = records(bystander.userId);
	const unrelated = [
		[randomUUID(), "not-json"],
		[
			randomUUID(),
			JSON.stringify({ type: "authentication", userData: { id: "" } }),
		],
	];
	const inserted = [...own, ...other, ...unrelated];
	try {
		for (const [identifier, value] of inserted)
			await admin.query(
				"insert into verification(id,identifier,value,expires_at) values($1,$2,$3,now()+interval '1 hour')",
				[randomUUID(), identifier, value],
			);
		const remaining = async (rows: string[][]) =>
			(
				await admin.query(
					"select count(*)::int n from verification where identifier=any($1::text[])",
					[rows.map(([identifier]) => identifier)],
				)
			).rows[0].n;
		expect(await remaining(own)).toBe(own.length);
		expect((await reset(victim.resetToken)).status).toBe(200);
		expect(await remaining(own)).toBe(0);
		expect(await remaining(other)).toBe(other.length);
		expect(await remaining(unrelated)).toBe(unrelated.length);
	} finally {
		await admin.query(
			"delete from verification where identifier=any($1::text[])",
			[inserted.map(([identifier]) => identifier)],
		);
	}
});

test("mailbox verification commits with the reset and rolls back with a later revocation failure", async () => {
	const victim = await seedAccount();
	const bystander = await seedAccount();
	await admin.query(
		'update "user" set email_verified=false where id=any($1::text[])',
		[[victim.userId, bystander.userId]],
	);
	const verified = async (userId: string) =>
		(
			await admin.query('select email_verified from "user" where id=$1', [
				userId,
			])
		).rows[0].email_verified;
	vi.spyOn(console, "error").mockImplementation(() => {});
	await admin.query(`revoke update on calendar_feed from "${role}"`);
	expect((await reset(victim.resetToken)).ok).toBe(false);
	expect(await verified(victim.userId)).toBe(false);
	expect(await passwordMatches(victim.userId, "old-password-123")).toBe(true);
	await admin.query(`grant update on calendar_feed to "${role}"`);
	expect((await reset(victim.resetToken)).status).toBe(200);
	expect(await verified(victim.userId)).toBe(true);
	expect(await verified(bystander.userId)).toBe(false);
	expect((await reset(victim.resetToken)).status).toBe(400);
});
