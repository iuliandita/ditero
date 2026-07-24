// The one mail transport in the codebase. Three callers: the email
// notification adapter, invite mail (Task 13) and Better Auth's
// verification/reset mail (Task 14). None of them chooses a server -- the SMTP
// host, port, credentials and from-address are operator env (config/mail.ts),
// because a caller-supplied host would be an SSRF primitive with no safeFetch
// equivalent behind it.
//
// nodemailer rather than a hand-rolled client: SMTP is not just a line protocol
// here, it is STARTTLS upgrade, SASL, dot-stuffing, MIME and quoted-printable.
// nodemailer is MIT-0 with zero runtime dependencies, so the usual reason to
// avoid a mail library (its dependency tree) does not apply.
import { createTransport, type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { MailConfig } from "../../config/mail.ts";
import { mailConfig } from "../../config/mail.ts";
import type { ChannelErrorCode } from "../../domain/notification-retry.ts";

export type MailMessage = {
	// Exactly one address. Every sender here is per-recipient, and a shared To
	// would expose one member's address to another.
	to: string;
	// Already header-safe and RFC 2047 encoded by the caller when it comes from
	// user input; `send` re-checks rather than trusting that.
	subject: string;
	text: string;
	urgent?: boolean;
};

export type MailFailure = {
	retryable: boolean;
	category: ChannelErrorCode;
	// The SMTP reply code, when the failure got that far. Reported so a caller
	// can map it; never a place for the server's reply text.
	smtpCode?: number;
	// Scrubbed of the SMTP credentials in every form they can appear on the
	// wire. Safe to log and to persist in delivery_attempt.error.
	message: string;
};

export type MailResult = { ok: true } | { ok: false; failure: MailFailure };

export type SendOptions = { signal?: AbortSignal; deadlineMs?: number };

export type Mailer = {
	readonly from: string;
	send(message: MailMessage, options?: SendOptions): Promise<MailResult>;
};

const DEFAULT_DEADLINE_MS = 15_000;
const SUBJECT_MAX = 998;
const TEXT_MAX = 64 * 1_024;

// SMTP's own permanent/transient split, which is the opposite of HTTP's: a 5xx
// reply is a final rejection that must not be retried, and a 4xx means "try
// again later". classifyRetry only ever calls a 4xx HTTP status permanent, so
// the mapping in the email adapter deliberately sends SMTP 5xx onto the HTTP
// 4xx band and SMTP 4xx onto 429.
const AUTH_CODES = new Set([432, 454, 530, 534, 535, 538]);
const MAILBOX_CODES = new Set([550, 551, 553]);

function smtpCategory(code: number, authFailed: boolean): ChannelErrorCode {
	if (authFailed || AUTH_CODES.has(code)) return "auth";
	if (MAILBOX_CODES.has(code)) return "not_found";
	if (code >= 400 && code < 500) return "rate_limited";
	return "policy";
}

type SmtpError = { responseCode?: unknown; code?: unknown; message?: unknown };

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value)
		? value
		: undefined;
}

// Exported for the unit tests: the mapping is the part with a wrong answer, and
// a real server will not produce all of these on demand.
export function classifySmtpError(error: unknown): MailFailure {
	const details = (error ?? {}) as SmtpError;
	const code = typeof details.code === "string" ? details.code : "";
	const message =
		typeof details.message === "string" ? details.message : "mail send failed";
	const smtpCode = numeric(details.responseCode);

	// Never silently downgraded: the connection could not be secured, so the
	// credentials were never sent. Retry is decided by the reply code, because
	// RFC 3207's "454 TLS not available due to temporary reason" arrives here as
	// ETLS and is transient by definition. A code-less failure is the
	// deterministic "server does not offer STARTTLS", which no retry fixes.
	// Retrying cannot leak the password: requireTLS is static config, so every
	// attempt makes the same demand and aborts at the same point.
	if (code === "ETLS" || /STARTTLS/i.test(message)) {
		return {
			retryable: smtpCode !== undefined && smtpCode < 500,
			category: "policy",
			smtpCode,
			message,
		};
	}
	if (smtpCode !== undefined) {
		const category = smtpCategory(smtpCode, code === "EAUTH");
		return {
			// SMTP 4xx is by definition "try again"; 5xx is by definition final.
			retryable: smtpCode < 500,
			category,
			smtpCode,
			message,
		};
	}
	// EENVELOPE with no reply code is a malformed address, which no retry fixes.
	if (code === "EENVELOPE") {
		return { retryable: false, category: "not_found", message };
	}
	// Everything left is a connect/DNS/socket failure or something nodemailer
	// did not classify. Retryable by default: a transient outage wrongly called
	// permanent loses the mail outright, while a permanent fault wrongly retried
	// only costs the ladder.
	return { retryable: true, category: "transport", message };
}

// Every form the credentials can take in a line the server or the library
// echoes back: the literals, and the base64 SASL payloads a verbose server can
// quote in its reply.
function scrubber(config: MailConfig): (text: string) => string {
	if (!config.auth) return (text) => text;
	const { user, password } = config.auth;
	const base64 = (value: string) =>
		Buffer.from(value, "utf8").toString("base64");
	const secrets = [
		password,
		// AUTH LOGIN sends the password base64 on a line of its own; AUTH PLAIN
		// sends one NUL-separated payload. A server that quotes the offending
		// line back in its reply hands us either form.
		base64(password),
		base64(`\0${user}\0${password}`),
	].filter((secret) => secret.length > 0);
	return (text) => {
		let out = text;
		for (const secret of secrets) out = out.split(secret).join("[REDACTED]");
		return out;
	};
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROL = /[\x00-\x1f\x7f]/;

export function createMailer(
	config: MailConfig,
	// Test seam. Production always uses the nodemailer transport built below.
	transport?: Pick<Transporter, "sendMail">,
): Mailer {
	const scrub = scrubber(config);
	// SMTPTransport, not SMTPPool: one connection per message. A pool would hold
	// an idle authenticated socket open for a mail volume that does not need it.
	const smtpOptions: SMTPTransport.Options = {
		host: config.host,
		port: config.port,
		secure: config.implicitTls,
		requireTLS: config.requireTls,
		// Belt and braces with requireTLS: `ignoreTLS` false keeps nodemailer
		// from skipping an offered upgrade even when it is not required.
		ignoreTLS: false,
		auth: config.auth
			? { user: config.auth.user, pass: config.auth.password }
			: undefined,
		tls: { minVersion: "TLSv1.2" },
	};
	const built = transport ?? createTransport(smtpOptions);

	return {
		from: config.from,
		async send(message, options = {}) {
			const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
			// The caller's title has already been through headerSafe, but this
			// module is what actually writes the header and three callers reach it.
			if (CONTROL.test(message.subject) || CONTROL.test(message.to)) {
				return {
					ok: false,
					failure: {
						retryable: false,
						category: "policy",
						message: "mail: control character in a header value",
					},
				};
			}
			try {
				const send = built.sendMail({
					from: config.from,
					to: message.to,
					subject: message.subject.slice(0, SUBJECT_MAX),
					// text/plain only: a title that reaches an HTML body would need
					// escaping, and nothing here needs markup.
					text: message.text.slice(0, TEXT_MAX),
					...(message.urgent ? { priority: "high" as const } : {}),
				});
				// With a single recipient there is no partial acceptance: a server that
				// refuses it makes nodemailer throw EENVELOPE rather than report it in
				// `info.rejected`.
				await withAbort(send, options.signal, deadlineMs);
				return { ok: true };
			} catch (error) {
				const failure = classifySmtpError(error);
				return {
					ok: false,
					failure: { ...failure, message: scrub(failure.message) },
				};
			}
		},
	};
}

class MailTimeout extends Error {
	// Classified by classifySmtpError's default branch: retryable transport.
	constructor(message: string) {
		super(message);
		this.name = "MailTimeout";
	}
}

async function withAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	deadlineMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new MailTimeout("mail: send deadline exceeded")),
					deadlineMs,
				);
				if (!signal) return;
				onAbort = () => reject(new MailTimeout("mail: send aborted"));
				if (signal.aborted) onAbort();
				else signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

// Null means SMTP is not configured, which is a supported deployment: the email
// channel is refused at save time and invite/auth mail report a disabled
// transport rather than the process failing to boot.
//
// Deliberately uncached. createTransport opens no socket, so rebuilding costs
// an object next to an SMTP round trip; caching on `env` identity would never
// invalidate when process.env is mutated in place, and hand a stale mailer to
// anything that configures SMTP after a first call.
export function mailerFromEnv(
	env: Record<string, string | undefined> = process.env,
): Mailer | null {
	const config = mailConfig(env);
	return config === null ? null : createMailer(config);
}
