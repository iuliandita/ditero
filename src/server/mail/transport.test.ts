// Every test here drives a REAL SMTP server over a real socket
// (tests/support/smtp-sink.ts) and asserts on the bytes it received. M3a's
// lesson was that a transport which threw on every real send stayed invisible
// for five tasks because every test injected a double; the classification table
// is the only part exercised without one, because no cooperative server
// produces a DNS failure on demand.
import { afterEach, describe, expect, it } from "vitest";
import type {
	SinkOptions,
	SmtpSink,
} from "../../../tests/support/smtp-sink.ts";
import { startSmtpSink } from "../../../tests/support/smtp-sink.ts";
import type { MailConfig } from "../../config/mail.ts";
import { classifySmtpError, createMailer } from "./transport.ts";

const sinks: SmtpSink[] = [];

afterEach(async () => {
	await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

async function sink(options: SinkOptions = {}): Promise<SmtpSink> {
	const started = await startSmtpSink(options);
	sinks.push(started);
	return started;
}

// A plaintext local relay is exactly the deployment the insecure opt-in exists
// for, so this is the honest fixture for a loopback sink -- not a weakened one.
function config(
	started: SmtpSink,
	overrides: Partial<MailConfig> = {},
): MailConfig {
	return {
		host: started.host,
		port: started.port,
		implicitTls: false,
		requireTls: false,
		auth: null,
		from: "Ditero <ditero@example.test>",
		...overrides,
	};
}

function headerValue(message: string, name: string): string | null {
	const line = message
		.split("\r\n")
		.find((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}:`));
	return line ? line.slice(name.length + 1).trim() : null;
}

describe("mail transport against a real SMTP server", () => {
	it("delivers a message and puts the operator from-address on the envelope", async () => {
		const started = await sink();
		const result = await createMailer(config(started)).send({
			to: "someone@example.test",
			subject: "Walk the dog",
			text: "Due tomorrow",
		});

		expect(result).toEqual({ ok: true });
		expect(started.commands).toContainEqual("MAIL FROM:<ditero@example.test>");
		expect(started.commands).toContainEqual("RCPT TO:<someone@example.test>");
		expect(started.messages).toHaveLength(1);
		expect(headerValue(started.messages[0], "Subject")).toBe("Walk the dog");
		expect(started.messages[0]).toContain("Due tomorrow");
	});

	it("cannot be made to inject a header through the subject", async () => {
		const started = await sink();
		const result = await createMailer(config(started)).send({
			to: "someone@example.test",
			// What headerSafe would have collapsed upstream, sent raw: this module
			// writes the header, and three callers reach it.
			subject: "Buy milk\r\nBcc: victim@example.test",
			text: "body",
		});

		expect(result).toMatchObject({ ok: false });
		expect(started.messages).toHaveLength(0);
	});

	// The `to` half of the same guard. Not reachable through the email adapter,
	// whose address is a parsed z.email(), but invite mail (Task 13) and auth
	// mail (Task 14) hand this module an address that has not been through one.
	// Without the guard nodemailer does not reject this: it reads the payload as
	// an address group and sends RCPT TO:<victim@example.test> INSTEAD of the
	// intended recipient, reporting ok. A recipient hijack, not just an extra
	// header.
	it("cannot be made to inject a header through the recipient", async () => {
		const started = await sink();
		const result = await createMailer(config(started)).send({
			to: "a@b.test\r\nBcc: victim@example.test",
			subject: "Buy milk",
			text: "body",
		});

		expect(result).toMatchObject({ ok: false });
		expect(started.messages).toHaveLength(0);
		expect(started.commands.some((line) => /^RCPT/i.test(line))).toBe(false);
	});

	it("carries a non-ASCII subject as an RFC 2047 encoded-word", async () => {
		const started = await sink();
		// Pre-encoded by the caller (adapters/email.ts), which is the contract:
		// what must not happen is the wire carrying raw UTF-8 or mojibake.
		const encoded = `=?UTF-8?B?${Buffer.from("Sortir le chien 🐕", "utf8").toString("base64")}?=`;
		await createMailer(config(started)).send({
			to: "someone@example.test",
			subject: encoded,
			text: "body",
		});

		const subject = headerValue(started.messages[0], "Subject");
		expect(subject).toBe(encoded);
		expect(subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
		expect(
			Buffer.from(subject?.slice(10, -2) ?? "", "base64").toString("utf8"),
		).toBe("Sortir le chien 🐕");
	});

	it("treats a 5xx recipient rejection as permanent", async () => {
		const started = await sink({
			replies: { rcpt: "550 5.1.1 <someone@example.test>: no such user" },
		});
		const result = await createMailer(config(started)).send({
			to: "someone@example.test",
			subject: "Walk the dog",
			text: "body",
		});

		expect(result).toMatchObject({
			ok: false,
			failure: { retryable: false, category: "not_found", smtpCode: 550 },
		});
	});

	it("treats a 4xx greylisting reply as retryable", async () => {
		const started = await sink({
			replies: { data: "451 4.7.1 greylisted, try again later" },
		});
		const result = await createMailer(config(started)).send({
			to: "someone@example.test",
			subject: "Walk the dog",
			text: "body",
		});

		expect(result).toMatchObject({
			ok: false,
			failure: { retryable: true, category: "rate_limited", smtpCode: 451 },
		});
	});

	it("never lets the SMTP password reach the failure, in any form the server can echo", async () => {
		const password = "hunter2-correct-horse";
		const user = "postmaster";
		const plain = Buffer.from(`\0${user}\0${password}`, "utf8").toString(
			"base64",
		);
		const started = await sink({
			advertiseAuth: true,
			// A server that quotes the offending line back is the realistic hostile
			// case -- and the only way the credential can reach an error string.
			replies: {
				auth: `535 5.7.8 Error: authentication failed: ${plain} (${password})`,
			},
		});
		const result = await createMailer(
			config(started, { auth: { user, password } }),
		).send({ to: "someone@example.test", subject: "Walk the dog", text: "b" });

		expect(result).toMatchObject({
			ok: false,
			failure: { retryable: false, category: "auth", smtpCode: 535 },
		});
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain(password);
		expect(serialized).not.toContain(plain);
		expect(serialized).toContain("[REDACTED]");
	});

	it("refuses to authenticate over a connection STARTTLS did not secure", async () => {
		// The server offers AUTH but no STARTTLS: without requireTls the
		// credentials would cross the wire in cleartext and nothing would look
		// wrong.
		const started = await sink({ advertiseAuth: true });
		const result = await createMailer(
			config(started, {
				requireTls: true,
				auth: { user: "postmaster", password: "hunter2" },
			}),
		).send({ to: "someone@example.test", subject: "Walk the dog", text: "b" });

		expect(result).toMatchObject({ ok: false, failure: { retryable: false } });
		expect(started.commands.some((line) => /^AUTH/i.test(line))).toBe(false);
		expect(started.messages).toHaveLength(0);
	});

	it("reports an unreachable server as retryable rather than throwing", async () => {
		const started = await sink();
		const port = started.port;
		await started.close();
		sinks.splice(sinks.indexOf(started), 1);

		const result = await createMailer({
			host: "127.0.0.1",
			port,
			implicitTls: false,
			requireTls: false,
			auth: null,
			from: "ditero@example.test",
		}).send(
			{ to: "someone@example.test", subject: "Walk the dog", text: "b" },
			{ deadlineMs: 5_000 },
		);

		expect(result).toMatchObject({
			ok: false,
			failure: { retryable: true, category: "transport" },
		});
	});
});

describe("classifySmtpError", () => {
	it("splits SMTP's permanent 5xx from its transient 4xx", () => {
		expect(
			classifySmtpError({ responseCode: 535, code: "EAUTH" }),
		).toMatchObject({ retryable: false, category: "auth" });
		expect(classifySmtpError({ responseCode: 550 })).toMatchObject({
			retryable: false,
			category: "not_found",
		});
		expect(classifySmtpError({ responseCode: 552 })).toMatchObject({
			retryable: false,
			category: "policy",
		});
		expect(classifySmtpError({ responseCode: 421 })).toMatchObject({
			retryable: true,
			category: "rate_limited",
		});
	});

	it("treats a failed TLS upgrade as permanent, never as something to retry in cleartext", () => {
		expect(
			classifySmtpError({ code: "ETLS", message: "STARTTLS not available" }),
		).toMatchObject({ retryable: false, category: "policy" });
	});

	// RFC 3207 gives the server a way to say "not now": 454 is explicitly
	// temporary. nodemailer raises it from _actionSTARTTLS as ETLS, so it lands
	// in the TLS branch, and a branch that ignored the reply code would fail the
	// outbox row permanently and lose the mail.
	it("retries the TLS refusal RFC 3207 defines as temporary", () => {
		expect(
			classifySmtpError({
				code: "ETLS",
				responseCode: 454,
				message: "454 4.7.0 TLS not available due to temporary reason",
			}),
		).toMatchObject({ retryable: true, category: "policy", smtpCode: 454 });
	});

	// The other ETLS shape carries no reply code because the server never sent
	// one: it is the deterministic "requireTLS but the server does not offer
	// STARTTLS", which no retry fixes. A socket drop mid-upgrade lands here too
	// and costs that one message, which is the cheaper error than retrying an
	// operator misconfiguration for the full ladder.
	it("keeps a code-less TLS failure permanent", () => {
		expect(
			classifySmtpError({
				code: "ETLS",
				message: "Connection closed unexpectedly",
			}),
		).toMatchObject({ retryable: false, category: "policy" });
	});

	it("defaults an unclassified failure to retryable", () => {
		expect(classifySmtpError(new Error("socket hang up"))).toMatchObject({
			retryable: true,
			category: "transport",
		});
	});
});
