// Invite mail against a real Postgres and a real SMTP server. The leak
// assertions read the DATA bytes the sink received, over a fixture that
// deliberately contains everything the mail must not carry: a task title, a list
// title, another member's address, and the invitee's role.
import { createServer, type Server, type Socket } from "node:net";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { createInvite } from "../../src/auth/invite-create.ts";
import type { MailConfig } from "../../src/config/mail.ts";
import * as tables from "../../src/db/schema.ts";
import { sendInviteMail } from "../../src/server/mail/invite-mail.ts";
import { createMailer } from "../../src/server/mail/transport.ts";
import type { SmtpSink } from "../support/smtp-sink.ts";
import { startSmtpSink } from "../support/smtp-sink.ts";

const databaseURL = process.env.DATABASE_URL;
if (!databaseURL) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString: databaseURL });
const db = drizzle(pool, { schema: tables });

// Every string here must be absent from the mail, and each is distinctive enough
// that a substring assertion cannot pass by accident.
const SECRET_TASK = "PLUTONIUM-SMUGGLING-ROUTE";
const SECRET_LIST = "OPERATION-QUIET-BADGER";
const SECRET_MEMBER_EMAIL = "bystander@leak-canary.invalid";

const sinks: SmtpSink[] = [];
const blackHoles: Array<() => void> = [];

// Accepts the TCP connection and then says nothing at all, so the send hangs
// until whatever deadline the caller applied. A request that waits on the
// transport's own 15s default is unmistakable against it.
async function blackHoleMailer() {
	const sockets: Socket[] = [];
	const server: Server = createServer((socket) => sockets.push(socket));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("black hole: no port");
	}
	blackHoles.push(() => {
		for (const socket of sockets) socket.destroy();
		server.close();
	});
	return createMailer({
		host: "127.0.0.1",
		port: address.port,
		implicitTls: false,
		requireTls: false,
		auth: null,
		from: "Ditero <ditero@example.test>",
	});
}

async function sink(
	replies?: Partial<Record<"mail" | "rcpt" | "data", string>>,
): Promise<SmtpSink> {
	const started = await startSmtpSink(replies ? { replies } : {});
	sinks.push(started);
	return started;
}

function mailerFor(started: SmtpSink) {
	const config: MailConfig = {
		host: started.host,
		port: started.port,
		implicitTls: false,
		requireTls: false,
		auth: null,
		from: "Ditero <ditero@example.test>",
	};
	return createMailer(config);
}

const ENV = { DITERO_PUBLIC_URL: "https://todo.example" };

async function seed() {
	await db.insert(tables.user).values([
		{ id: "owner", name: "Ada Lovelace", email: "owner@test.invalid" },
		{ id: "bystander", name: "Bystander", email: SECRET_MEMBER_EMAIL },
	]);
	await db.insert(tables.workspace).values({
		id: "shared",
		name: "Renovation",
		ownerId: "owner",
		kind: "shared",
	});
	await db.insert(tables.membership).values([
		{ id: "m-owner", userId: "owner", workspaceId: "shared", role: "owner" },
		{
			id: "m-bystander",
			userId: "bystander",
			workspaceId: "shared",
			role: "member",
		},
	]);
	await db.insert(tables.list).values({
		id: "shared-list",
		workspaceId: "shared",
		ownerId: "owner",
		title: SECRET_LIST,
		sortKey: "a0",
	});
	await db.insert(tables.task).values({
		id: "shared-task",
		listId: "shared-list",
		title: SECRET_TASK,
		sortKey: "a0",
	});
}

async function clean() {
	await db.delete(tables.taskAssignee);
	await db.delete(tables.invite);
	await db.delete(tables.task);
	await db.delete(tables.list);
	await db.delete(tables.membership);
	await db.delete(tables.workspace);
	await db.delete(tables.user);
}

beforeEach(async () => {
	await clean();
	await seed();
});

afterEach(async () => {
	for (const stop of blackHoles.splice(0)) stop();
	await Promise.all(sinks.splice(0).map((s) => s.close()));
});

// Left behind, this fixture's list rows break any later file whose own cleanup
// deletes `workspace` before `list`.
afterAll(async () => {
	await clean();
	await pool.end();
});

// Mirrors the /api/invite/create handler: create, then mail, then report.
async function createAndMail(
	started: SmtpSink | null,
	email: string | null,
	extra: Partial<Parameters<typeof createInvite>[0]> = {},
) {
	const invite = await createInvite(
		{ workspaceId: "shared", role: "member", email, ...extra },
		"owner",
		db,
		ENV,
	);
	const mail = await sendInviteMail(
		{
			email,
			token: invite.token,
			workspaceId: "shared",
			inviterId: "owner",
		},
		{
			database: db,
			env: ENV,
			mailer: started === null ? null : mailerFor(started),
		},
	);
	return { invite, mail };
}

describe("invite mail", () => {
	test("an invite with an address is mailed, and the link uses the public URL", async () => {
		const started = await sink();
		const { invite, mail } = await createAndMail(
			started,
			"invitee@example.test",
		);

		expect(mail).toEqual({ status: "sent" });
		expect(started.commands).toContain("RCPT TO:<invitee@example.test>");
		expect(started.messages[0]).toContain(
			`https://todo.example/accept?token=${invite.token}`,
		);
		expect(invite.link).toBe(
			`https://todo.example/accept?token=${invite.token}`,
		);
	});

	// The invite-on-assign case: M1b attaches a task, and the mail must not name
	// it. The fixture's task title is the string this asserts on.
	test("the mail carries no task, list, member or role detail", async () => {
		const started = await sink();
		const { mail } = await createAndMail(started, "invitee@example.test", {
			attachTaskId: "shared-task",
			attachKind: "assign",
		});
		expect(mail).toEqual({ status: "sent" });

		const message = started.messages[0];
		expect(message).toBeDefined();
		for (const secret of [
			SECRET_TASK,
			SECRET_LIST,
			SECRET_MEMBER_EMAIL,
			"shared-task",
			"shared-list",
		]) {
			expect(message, secret).not.toContain(secret);
		}
		// Role is withheld for the same reason previewInvite withholds it.
		expect(message).not.toMatch(/\bmember\b/i);
		// The fixture proves the omission is a choice, not an empty workspace: the
		// two values that ARE allowed are present.
		expect(message).toContain("Renovation");
		expect(message).toContain("Ada Lovelace");
	});

	test("SMTP unconfigured still creates the invite and reports it", async () => {
		const { invite, mail } = await createAndMail(null, "invitee@example.test");
		expect(mail).toEqual({ status: "smtp_disabled" });
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, invite.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].status).toBe("pending");
	});

	test("a send failure surfaces but does not destroy the invite", async () => {
		const started = await sink({ rcpt: "550 5.1.1 no such user" });
		const { invite, mail } = await createAndMail(
			started,
			"invitee@example.test",
		);

		expect(mail).toEqual({
			status: "failed",
			retryable: false,
			category: "not_found",
		});
		const rows = await db
			.select()
			.from(tables.invite)
			.where(eq(tables.invite.id, invite.id));
		expect(rows).toHaveLength(1);
		expect(rows[0].token).toBe(invite.token);
		// Still redeemable: the link is the fallback the inviter is told to use.
		expect(rows[0].status).toBe("pending");
	});

	// The inviter's request awaits this send, so an unresponsive SMTP server
	// would otherwise hold the connection for the transport's full 15s default.
	test("a dead SMTP server cannot hold the invite request open", async () => {
		const mailer = await blackHoleMailer();
		const invite = await createInvite(
			{ workspaceId: "shared", role: "member", email: "invitee@example.test" },
			"owner",
			db,
			ENV,
		);

		const started = Date.now();
		const mail = await sendInviteMail(
			{
				email: "invitee@example.test",
				token: invite.token,
				workspaceId: "shared",
				inviterId: "owner",
			},
			{ database: db, env: ENV, mailer },
		);
		const elapsed = Date.now() - started;

		expect(mail).toMatchObject({ status: "failed", retryable: true });
		expect(elapsed).toBeLessThan(10_000);
	}, 25_000);

	test("a control character in the address cannot redirect delivery", async () => {
		const started = await sink();
		// One "@" and a well-formed domain, so this is the shape only the
		// control-character guard rejects; the address-shape checks would pass it.
		const hijack = "inv\r\nitee@example.test";
		// createInvite's own z.email() rejects it first, so the row never exists --
		// but sendInviteMail is reached directly by the same address to prove the
		// mail layer refuses it independently.
		await expect(createAndMail(started, hijack)).rejects.toThrow(
			/invalid email/,
		);

		const mail = await sendInviteMail(
			{
				email: hijack,
				token: "tok",
				workspaceId: "shared",
				inviterId: "owner",
			},
			{ database: db, env: ENV, mailer: mailerFor(started) },
		);
		expect(mail).toEqual({ status: "invalid_address" });
		expect(started.commands).toHaveLength(0);
		expect(started.messages).toHaveLength(0);
	});
});
