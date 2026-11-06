import { drizzle } from "drizzle-orm/node-postgres";
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
import { auth } from "../../src/auth/auth.ts";
import { acceptInvite, previewInvite } from "../../src/auth/invite-accept.ts";
import { emailHasTokenInvite } from "../../src/auth/invite-bypass.ts";
import { claimFastInvite } from "../../src/auth/invite-fast-path.ts";
import {
	INVITE_MAILBOX_TTL_MS,
	proveInviteMailbox,
	sendInviteMailboxProof,
} from "../../src/auth/invite-mailbox.ts";
import * as tables from "../../src/db/schema.ts";
import { app } from "../../src/server/index.ts";
import { signInForTest } from "../support/auth-sign-in.ts";
import { type SmtpSink, startSmtpSink } from "../support/smtp-sink.ts";
import { resetAuthFixture } from "./reset-auth-fixture.ts";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(runtime, { schema: tables });
let sink: SmtpSink;

beforeAll(async () => {
	await pool.query(
		`create role invite_mailbox_runtime nosuperuser nocreatedb nocreaterole noinherit nobypassrls`,
	);
	await pool.query("grant usage on schema public to invite_mailbox_runtime");
	await pool.query(
		"grant select, insert, update, delete on all tables in schema public to invite_mailbox_runtime",
	);
	runtime.on("connect", (client) => {
		void client.query("set role invite_mailbox_runtime");
	});
	sink = await startSmtpSink();
});
beforeEach(async () => {
	await resetAuthFixture(pool);
	await pool.query("delete from rate_bucket");
	vi.stubEnv("DITERO_SMTP_HOST", sink.host);
	vi.stubEnv("DITERO_SMTP_PORT", String(sink.port));
	vi.stubEnv("DITERO_SMTP_FROM", "Ditero <ditero@example.test>");
	vi.stubEnv("DITERO_SMTP_ALLOW_INSECURE", "true");
	vi.stubEnv("DITERO_PUBLIC_URL", "http://localhost:3000");
	sink.messages.length = 0;
	sink.commands.length = 0;
	await pool.query(`insert into "user" (id,name,email) values
 ('owner','Owner','owner@example.test'),('joiner','Joiner','invited@example.test'),('other','Other','other@example.test')`);
	await pool.query(
		`insert into workspace (id,name,kind,owner_id) values ('ws','Shared','shared','owner')`,
	);
	await pool.query(
		`insert into membership (id,user_id,workspace_id,role) values ('owner-seat','owner','ws','owner')`,
	);
	await pool.query(
		`insert into workspace_key (id,workspace_id,version,commitment,minted_by,active) values ('wk','ws',1,'commitment','owner',true)`,
	);
	await pool.query(`insert into invite (id,workspace_id,role,email,token,status,max_uses,expires_at,created_by)
 values ('mailbox','ws','admin','Invited@example.test','mailbox-token','pending',1,now()+interval '10 minutes','owner')`);
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
	await resetAuthFixture(pool);
	await runtime.end();
	await pool.query("drop owned by invite_mailbox_runtime");
	await pool.query("drop role invite_mailbox_runtime");
	await pool.end();
	await sink.close();
});

async function proofFromMail() {
	await vi.waitFor(() => expect(sink.messages).toHaveLength(1));
	const message = sink.messages[0];
	if (!message) throw new Error("mail missing");
	const body = message.replace(/=\r\n/g, "").replace(/=3D/g, "=");
	const link = body.match(/http:\/\/localhost:3000\/accept#[^\s]+/)?.[0];
	if (!link) throw new Error("proof link missing");
	const params = new URLSearchParams(new URL(link).hash.slice(1));
	expect(params.get("token")).toBe("mailbox-token");
	expect(
		sink.commands.some((c) => c === "RCPT TO:<invited@example.test>"),
	).toBe(true);
	const proof = params.get("proof");
	if (!proof) throw new Error("proof missing");
	return proof;
}

test.each([
	"legacy",
	"fragment",
] as const)("%s withholds the role until mailbox confirmation", async (path) => {
	const redeem = () =>
		path === "legacy"
			? acceptInvite("mailbox-token", "joiner", "invited@example.test", db)
			: claimFastInvite(
					runtime,
					"mailbox-token",
					"joiner",
					"invited@example.test",
				);
	await expect(redeem()).rejects.toThrow("email_verification_required");
	expect(
		(await pool.query("select user_id from membership where workspace_id='ws'"))
			.rows,
	).toEqual([{ user_id: "owner" }]);
	expect(
		(await pool.query("select uses, claimed_by from invite")).rows,
	).toEqual([{ uses: 0, claimed_by: null }]);
	await sendInviteMailboxProof("mailbox-token", "joiner", db);
	const proof = await proofFromMail();
	expect(await proveInviteMailbox(proof, "other", db)).toBe(false);
	expect(await proveInviteMailbox(proof, "joiner", db)).toBe(true);
	expect(await proveInviteMailbox(proof, "joiner", db)).toBe(false);
	expect(
		(await pool.query("select email_verified from \"user\" where id='joiner'"))
			.rows,
	).toEqual([{ email_verified: true }]);
	await redeem();
	expect(
		(
			await pool.query(
				"select role from membership where user_id='joiner' and workspace_id='ws'",
			)
		).rows,
	).toEqual([{ role: "admin" }]);
});

test("resends do not invalidate proof and expiry never verifies an account", async () => {
	const now = Date.now();
	expect(
		await sendInviteMailboxProof("mailbox-token", "joiner", db, now),
	).toBeUndefined();
	const proof = await proofFromMail();
	expect(
		await sendInviteMailboxProof("mailbox-token", "joiner", db, now),
	).toBeUndefined();
	expect(
		await sendInviteMailboxProof("unknown", "joiner", db, now),
	).toBeUndefined();
	expect(
		await sendInviteMailboxProof("mailbox-token", "other", db, now),
	).toBeUndefined();
	expect(sink.messages).toHaveLength(1);
	expect(
		(await pool.query("select count(*)::int as count from verification"))
			.rows[0].count,
	).toBe(1);
	expect(
		await proveInviteMailbox(proof, "joiner", db, now + INVITE_MAILBOX_TTL_MS),
	).toBe(false);
	expect(await proveInviteMailbox(proof, "joiner", db, now + 1)).toBe(true);
});

test.each([
	"verified",
	"smtp-disabled",
	"open",
] as const)("%s can still grant without another proof", async (mode) => {
	if (mode === "verified")
		await pool.query(
			"update \"user\" set email_verified=true where id='joiner'",
		);
	if (mode === "smtp-disabled") vi.stubEnv("DITERO_SMTP_HOST", "");
	if (mode === "open") await pool.query("update invite set email=null");
	await acceptInvite("mailbox-token", "joiner", "invited@example.test", db);
	expect(
		(
			await pool.query(
				"select role from membership where user_id='joiner' and workspace_id='ws'",
			)
		).rows,
	).toEqual([{ role: "admin" }]);
});

test("preview masks the binding, while password admission requires the matching bearer", async () => {
	expect(await previewInvite("mailbox-token", db)).toEqual({
		valid: true,
		workspaceName: "Shared",
		maskedEmail: "I***@example.test",
	});
	expect(
		await emailHasTokenInvite(
			"invited@example.test",
			undefined,
			db,
			Date.now(),
		),
	).toBe(false);
	expect(
		await emailHasTokenInvite(
			" INVITED@example.test ",
			"mailbox-token",
			db,
			Date.now(),
		),
	).toBe(true);
	expect(
		await emailHasTokenInvite(
			"other@example.test",
			"mailbox-token",
			db,
			Date.now(),
		),
	).toBe(false);
	for (const change of [
		"status='revoked'",
		"status='accepted'",
		"expires_at=now()-interval '1 second'",
		"uses=1",
		"claimed_by='other'",
		"email=null",
	]) {
		await pool.query(
			"update invite set status='pending',expires_at=now()+interval '10 minutes',uses=0,claimed_by=null,email='Invited@example.test'",
		);
		await pool.query(`update invite set ${change}`);
		expect(
			await emailHasTokenInvite(
				"invited@example.test",
				"mailbox-token",
				db,
				Date.now(),
			),
		).toBe(false);
	}
});

test("HTTP confirmation preserves session guards and identical resend acknowledgements", async () => {
	vi.stubEnv("DITERO_E2E_ENABLED", "true");
	const password = await (await auth.$context).password.hash("pw-123456");
	await pool.query(
		"insert into account (id,account_id,provider_id,user_id,password,created_at,updated_at) values ('joiner-account','joiner','credential','joiner',$1,now(),now())",
		[password],
	);
	const signedIn = await signInForTest("invited@example.test");
	const cookie = signedIn.headers
		.getSetCookie()
		.map((v) => v.split(";", 1)[0])
		.join("; ");
	const call = (
		path: string,
		body: unknown,
		credentials = cookie,
		origin = "http://localhost:5173",
	) =>
		app.handle(
			new Request(`http://localhost:3000/api/invite/${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie: credentials,
					origin,
				},
				body: JSON.stringify(body),
			}),
		);
	expect(
		(await call("verify-email", { token: "mailbox-token" }, "")).status,
	).toBe(401);
	expect(
		(
			await call(
				"verify-email",
				{ token: "mailbox-token" },
				cookie,
				"https://other.example.test",
			)
		).status,
	).toBe(403);
	for (const path of ["accept", "claim"]) {
		const response = await call(path, { token: "mailbox-token" });
		expect(response.status).toBe(403);
		expect(await response.text()).toBe("email_verification_required");
	}
	const replies = [];
	for (const token of ["mailbox-token", "mailbox-token", "unknown"]) {
		const response = await call("verify-email", { token });
		replies.push({ status: response.status, body: await response.json() });
	}
	expect(replies).toEqual(
		Array.from({ length: 3 }, () => ({ status: 200, body: { sent: true } })),
	);
	const proof = await proofFromMail();
	expect((await call("verify-email", { proof })).status).toBe(200);
	expect((await call("verify-email", { proof })).status).toBe(400);
	expect((await call("accept", { token: "mailbox-token" })).status).toBe(200);
	expect(
		(
			await pool.query(
				"select role from membership where user_id='joiner' and workspace_id='ws'",
			)
		).rows,
	).toEqual([{ role: "admin" }]);
	expect(
		(
			await runtime.query(
				"select rolsuper,rolbypassrls from pg_roles where rolname=current_user",
			)
		).rows,
	).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});
