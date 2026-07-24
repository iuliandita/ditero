// Real SMTP server on a real socket, same fixture the transport tests use:
// every assertion about what was or was not sent reads the wire, not a double.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SinkOptions, SmtpSink } from "../../tests/support/smtp-sink.ts";
import { startSmtpSink } from "../../tests/support/smtp-sink.ts";
import * as paraglideRuntime from "../paraglide/runtime.js";
import {
	mailUnavailableResponse,
	publicAuthLink,
	sendAuthMail,
} from "./mail.ts";

type AuthMailDb = NonNullable<Parameters<typeof sendAuthMail>[3]>["database"];

// resolveRecipientLocale issues one select for the user's stored locale.
function stubUserPrefDb(locale: string | null): AuthMailDb {
	const chain = {
		from: () => chain,
		where: () => chain,
		limit: () => Promise.resolve([{ locale }]),
	};
	return { select: () => chain } as unknown as AuthMailDb;
}

const sinks: SmtpSink[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(sinks.splice(0).map((sink) => sink.close()));
});

async function sink(options: SinkOptions = {}): Promise<SmtpSink> {
	const started = await startSmtpSink(options);
	sinks.push(started);
	return started;
}

function smtpEnv(
	started: SmtpSink,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		DITERO_SMTP_HOST: started.host,
		DITERO_SMTP_PORT: String(started.port),
		// A plaintext loopback relay is the deployment the opt-in exists for.
		DITERO_SMTP_ALLOW_INSECURE: "true",
		DITERO_SMTP_FROM: "Ditero <ditero@example.test>",
		BETTER_AUTH_URL: "http://localhost:3000",
		...extra,
	};
}

// The send is detached in production, so tests take the tracked promise rather
// than sleeping.
async function send(
	kind: "verify" | "reset",
	user: { email: string; name?: string | null },
	url: string,
	env: Record<string, string>,
	mailer?: null,
): Promise<void> {
	let settled: Promise<void> | undefined;
	sendAuthMail(kind, user, url, {
		env,
		track: (promise) => {
			settled = promise;
		},
		...(mailer === null ? { mailer: null } : {}),
	});
	await settled;
}

// nodemailer picks quoted-printable for these bodies, so a link assertion has
// to read the decoded text: `=` arrives as `=3D` and long lines are soft-wrapped.
function decodeBody(message: string): string {
	return message
		.replace(/=\r\n/g, "")
		.replace(/=([0-9A-F]{2})/g, (_, hex) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
}

const TOKEN = "tok-6b9c1f2e4a";
const RESET_URL = `http://localhost:3000/api/auth/reset-password/${TOKEN}?callbackURL=%2F`;
const VERIFY_URL = `http://localhost:3000/api/auth/verify-email?token=${TOKEN}&callbackURL=%2F`;

describe("auth mail", () => {
	it("sends verification mail with the token link intact", async () => {
		const started = await sink();
		await send(
			"verify",
			{ email: "someone@example.test", name: "Ada" },
			VERIFY_URL,
			smtpEnv(started),
		);

		expect(started.commands).toContainEqual("RCPT TO:<someone@example.test>");
		expect(started.messages).toHaveLength(1);
		expect(started.messages[0]).toContain(
			"Subject: Confirm your email address",
		);
		expect(started.messages[0]).toContain("Hi Ada,");
		expect(decodeBody(started.messages[0])).toContain(VERIFY_URL);
	});

	// The recipient of auth mail is a registered user, so their stored locale is
	// honored. No translations exist yet, so a "de" recipient still receives
	// English; what is asserted is that an explicit locale reaches every m.* call,
	// which a threaded render proves by never consulting the ambient getLocale.
	it("threads the recipient's locale rather than consulting the ambient locale", async () => {
		const started = await sink();
		const getLocale = vi.spyOn(paraglideRuntime, "getLocale");
		let settled: Promise<void> | undefined;
		sendAuthMail(
			"verify",
			{ id: "u1", email: "someone@example.test", name: "Ada" },
			VERIFY_URL,
			{
				env: smtpEnv(started),
				database: stubUserPrefDb("de"),
				track: (promise) => {
					settled = promise;
				},
			},
		);
		await settled;
		expect(getLocale).not.toHaveBeenCalled();
		expect(started.messages).toHaveLength(1);
		expect(started.messages[0]).toContain(
			"Subject: Confirm your email address",
		);
	});

	it("builds the link from the configured public URL, not Better Auth's", async () => {
		const started = await sink();
		await send(
			"reset",
			{ email: "someone@example.test" },
			RESET_URL,
			smtpEnv(started, { DITERO_PUBLIC_URL: "https://todo.example" }),
		);

		expect(decodeBody(started.messages[0])).toContain(
			`https://todo.example/api/auth/reset-password/${TOKEN}?callbackURL=%2F`,
		);
		expect(decodeBody(started.messages[0])).not.toContain("localhost:3000");
	});

	// Without a guard at this layer nodemailer reads the payload as an address
	// group and sends RCPT TO:<victim> INSTEAD of the intended recipient. The
	// transport also refuses it; this asserts the refusal happens here, before
	// the address is ever handed over.
	// The previous fixture here ("a@b.test<CR><LF>Bcc: ...") was rejected by the
	// address-SHAPE checks -- two "@" -- so the control-character guard was never
	// reached and could be deleted with every test still passing. This shape has
	// one "@" and a well-formed domain, so only the control guard rejects it.
	it("refuses a recipient carrying a control character", async () => {
		const started = await sink();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await send(
			"reset",
			{ email: "inv\r\nitee@example.test" },
			RESET_URL,
			smtpEnv(started),
		);

		expect(error).toHaveBeenCalledWith(
			"auth mail: refusing reset mail to a malformed address",
		);
		expect(started.commands).toEqual([]);
		expect(started.messages).toHaveLength(0);
	});

	it("never puts the link or its token in a log line", async () => {
		const started = await sink({ replies: { rcpt: "550 5.1.1 no such user" } });
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await send(
			"reset",
			{ email: "someone@example.test" },
			RESET_URL,
			smtpEnv(started),
		);

		expect(error).toHaveBeenCalled();
		const logged = [...error.mock.calls, ...warn.mock.calls]
			.flat()
			.map((entry) => String(entry))
			.join("\n");
		expect(logged).not.toContain(TOKEN);
		expect(logged).not.toContain("reset-password");
	});

	it("warns and sends nothing when SMTP is not configured", async () => {
		const started = await sink();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await send(
			"verify",
			{ email: "someone@example.test" },
			VERIFY_URL,
			// No DITERO_SMTP_HOST: mailerFromEnv returns null.
			{ BETTER_AUTH_URL: "http://localhost:3000" },
		);

		expect(warn).toHaveBeenCalledWith(
			"auth mail: SMTP is not configured, no verify mail sent to someone@example.test",
		);
		expect(started.commands).toEqual([]);
	});

	it("skips the synthetic handle a managed account is given", async () => {
		const started = await sink();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await send(
			"verify",
			{ email: "kid.1234@managed.invalid" },
			VERIFY_URL,
			smtpEnv(started),
		);

		expect(started.commands).toEqual([]);
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});
});

// The address predicate itself lives in src/domain/mail-address.ts and is
// tested there; what this file asserts is that the auth path applies it.

describe("publicAuthLink", () => {
	it("falls back to Better Auth's own URL when no public origin is set", () => {
		expect(publicAuthLink(RESET_URL, {})).toBe(RESET_URL);
	});

	it("keeps a non-URL value rather than mangling it", () => {
		expect(
			publicAuthLink("not a url", { DITERO_PUBLIC_URL: "https://x.test" }),
		).toBe("not a url");
	});
});

describe("mailUnavailableResponse", () => {
	const reset = new Request(
		"http://localhost:3000/api/auth/request-password-reset",
		{ method: "POST" },
	);

	it("refuses the mail-only routes when SMTP is not configured", async () => {
		const response = mailUnavailableResponse(reset, {});
		expect(response?.status).toBe(503);
		expect(await response?.json()).toMatchObject({
			code: "MAIL_NOT_CONFIGURED",
		});
	});

	it("stands aside once SMTP is configured", async () => {
		const started = await sink();
		expect(mailUnavailableResponse(reset, smtpEnv(started))).toBeNull();
	});

	it("leaves every other auth route alone", () => {
		const signUp = new Request("http://localhost:3000/api/auth/sign-up/email", {
			method: "POST",
		});
		expect(mailUnavailableResponse(signUp, {})).toBeNull();
	});
});
