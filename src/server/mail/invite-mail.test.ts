// Every send here goes over a real socket to a real SMTP server
// (tests/support/smtp-sink.ts) and asserts on the bytes it received. Asserting
// against a mailer double would not have caught the recipient hijack, which is
// visible only in the RCPT TO line.
import { afterEach, describe, expect, it } from "vitest";
import type { SmtpSink } from "../../../tests/support/smtp-sink.ts";
import { startSmtpSink } from "../../../tests/support/smtp-sink.ts";
import type { MailConfig } from "../../config/mail.ts";
import { sendInviteMail } from "./invite-mail.ts";
import { createMailer } from "./transport.ts";

const sinks: SmtpSink[] = [];

afterEach(async () => {
	await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

async function sink(
	replies?: Partial<Record<"mail" | "rcpt" | "data", string>>,
): Promise<SmtpSink> {
	const started = await startSmtpSink(replies ? { replies } : {});
	sinks.push(started);
	return started;
}

function config(started: SmtpSink): MailConfig {
	return {
		host: started.host,
		port: started.port,
		implicitTls: false,
		requireTls: false,
		auth: null,
		from: "Ditero <ditero@example.test>",
	};
}

// sendInviteMail issues exactly two selects: workspace name, then inviter name.
function stubDb(workspaceName: string, inviterName: string) {
	const results = [[{ name: workspaceName }], [{ name: inviterName }]];
	let next = 0;
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve(results[next++] ?? []),
	};
	return { select: () => chain } as unknown as Parameters<
		typeof sendInviteMail
	>[1]["database"];
}

const ENV = { DITERO_PUBLIC_URL: "https://todo.example" };

const INPUT = {
	email: "invitee@example.test",
	token: "tok-123",
	workspaceId: "w1",
	inviterId: "u1",
};

// The address predicate itself lives in src/domain/mail-address.ts and is
// tested there; what this file asserts is that the invite path applies it.
describe("sendInviteMail", () => {
	it("sends the invite and points the link at the configured public URL", async () => {
		const started = await sink();
		const status = await sendInviteMail(INPUT, {
			database: stubDb("Renovation", "Ada"),
			env: ENV,
			mailer: createMailer(config(started)),
		});

		expect(status).toEqual({ status: "sent" });
		expect(started.commands).toContain("RCPT TO:<invitee@example.test>");
		const message = started.messages[0];
		expect(message).toContain("https://todo.example/accept?token=tok-123");
		expect(message).toContain("Ada invited you to join Renovation on Ditero.");
		expect(message).toMatch(
			/^Subject: Ada invited you to Renovation on Ditero/m,
		);
	});

	it("strips a trailing slash rather than minting a double-slash link", async () => {
		const started = await sink();
		await sendInviteMail(INPUT, {
			database: stubDb("W", "A"),
			env: { DITERO_PUBLIC_URL: "https://todo.example/" },
			mailer: createMailer(config(started)),
		});
		expect(started.messages[0]).toContain(
			"https://todo.example/accept?token=tok-123",
		);
		expect(started.messages[0]).not.toContain("example//accept");
	});

	it("reports smtp_disabled, without throwing, when SMTP is unconfigured", async () => {
		// No mailer key: the env path resolves it, and an env with no
		// DITERO_SMTP_HOST is the supported "no mail server" deployment.
		const status = await sendInviteMail(INPUT, {
			database: stubDb("W", "A"),
			env: ENV,
		});
		expect(status).toEqual({ status: "smtp_disabled" });
	});

	it("refuses to mail a localhost link when no public URL is configured", async () => {
		const started = await sink();
		const status = await sendInviteMail(INPUT, {
			database: stubDb("W", "A"),
			env: {},
			mailer: createMailer(config(started)),
		});
		expect(status).toEqual({ status: "no_public_url" });
		expect(started.messages).toHaveLength(0);
	});

	it("skips a link invite that carries no address", async () => {
		const started = await sink();
		const status = await sendInviteMail(
			{ ...INPUT, email: null },
			{
				database: stubDb("W", "A"),
				env: ENV,
				mailer: createMailer(config(started)),
			},
		);
		expect(status).toEqual({ status: "skipped" });
		expect(started.messages).toHaveLength(0);
	});

	it("reports a permanent rejection with its category", async () => {
		const started = await sink({ rcpt: "550 5.1.1 no such user" });
		const status = await sendInviteMail(INPUT, {
			database: stubDb("W", "A"),
			env: ENV,
			mailer: createMailer(config(started)),
		});
		expect(status).toEqual({
			status: "failed",
			retryable: false,
			category: "not_found",
		});
	});

	it("reports a transient rejection as retryable", async () => {
		const started = await sink({ rcpt: "451 4.3.0 try later" });
		const status = await sendInviteMail(INPUT, {
			database: stubDb("W", "A"),
			env: ENV,
			mailer: createMailer(config(started)),
		});
		expect(status).toMatchObject({ status: "failed", retryable: true });
	});

	// The hijack: nodemailer parses `to` as an address LIST, so a CRLF turns the
	// value into a group and the envelope goes to the injected address INSTEAD of
	// the intended one -- reporting success. Rejected at this layer, so nothing
	// reaches the wire at all.
	it("cannot be redirected by a control character in the address", async () => {
		const started = await sink();
		const status = await sendInviteMail(
			// Deliberately the shape only the control-character guard rejects: one
			// "@" and a valid domain, so the address-shape checks would pass it.
			{ ...INPUT, email: "inv\r\nitee@example.test" },
			{
				database: stubDb("W", "A"),
				env: ENV,
				mailer: createMailer(config(started)),
			},
		);
		expect(status).toEqual({ status: "invalid_address" });
		expect(started.commands.filter((c) => c.startsWith("RCPT"))).toEqual([]);
		expect(started.commands).toHaveLength(0);
	});

	it("encodes a non-ASCII workspace name rather than emitting a raw header", async () => {
		const started = await sink();
		await sendInviteMail(INPUT, {
			database: stubDb("Café", "Ada"),
			env: ENV,
			mailer: createMailer(config(started)),
		});
		expect(started.messages[0]).toContain("Subject: =?UTF-8?B?");
		expect(started.messages[0]).not.toMatch(/^Subject:.*Café/m);
	});

	// A CRLF in a workspace name would otherwise splice a header, or a body, into
	// the message from the Subject line.
	it("neutralises a header injection in the workspace name", async () => {
		const started = await sink();
		await sendInviteMail(INPUT, {
			database: stubDb("W\r\nBcc: victim@evil.test", "Ada"),
			env: ENV,
			mailer: createMailer(config(started)),
		});
		expect(started.messages[0]).not.toContain("victim@evil.test\r\n");
		expect(started.messages[0]).not.toMatch(/^Bcc:/m);
	});
});
