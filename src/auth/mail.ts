// Better Auth's verification and password-reset mail, on the one shared SMTP
// transport (server/mail/transport.ts).
//
// Two rules shape every function here.
//
// Fail-loud but non-blocking: a self-hoster with no mail server, or a broken
// one, must still be able to create an account, so nothing in this file can
// fail a request. Every failure instead leaves an operator-visible line in the
// log. The user-facing half of "loud" is the reset gate below, which refuses
// the flow outright rather than answering "check your email" for a mail that
// was never sent.
//
// Never awaited: the SMTP round trip is detached from the request. Better
// Auth's /request-password-reset answers identically for a known and an
// unknown address by design, but awaiting a send would reintroduce the
// difference as latency -- known addresses would take an SMTP round trip
// longer, which is the same oracle in a different unit.
import { mailableAddress } from "../domain/mail-address.ts";
import { encodeHeaderValue, headerSafe } from "../domain/mime-header.ts";
import { m } from "../paraglide/messages.js";
import { type Mailer, mailerFromEnv } from "../server/mail/transport.ts";
import { ackBaseUrl } from "../server/notifications/capability.ts";

export type AuthMailKind = "verify" | "reset";

const SUBJECT_MAX = 200;
const NAME_MAX = 100;

// RFC 6761: `.invalid` is guaranteed never to resolve. Managed ("kid") accounts
// get a synthetic handle in it, so mail to one is a 15-second connect failure
// and a log line for something that was never an address.
function isUndeliverableByConstruction(address: string): boolean {
	return address.toLowerCase().endsWith(".invalid");
}

// Better Auth builds its links from its own baseURL, which is BETTER_AUTH_URL
// and nothing else. ackBaseUrl is the codebase's single notion of a public
// origin (DITERO_PUBLIC_URL, falling back to BETTER_AUTH_URL); a deployment
// that set only the former would otherwise mail out a link to localhost.
// Path and query come from Better Auth so the token and callback survive
// untouched.
export function publicAuthLink(
	rawUrl: string,
	env: Record<string, string | undefined> = process.env,
): string {
	const base = ackBaseUrl(env);
	if (base === null) return rawUrl;
	try {
		const target = new URL(rawUrl);
		return `${new URL(base).href.replace(/\/+$/, "")}${target.pathname}${target.search}`;
	} catch {
		return rawUrl;
	}
}

function compose(
	kind: AuthMailKind,
	params: { name: string; url: string },
): { subject: string; text: string } {
	return kind === "verify"
		? {
				subject: m.auth_mail_verify_subject(),
				text: m.auth_mail_verify_body(params),
			}
		: {
				subject: m.auth_mail_reset_subject(),
				text: m.auth_mail_reset_body(params),
			};
}

export type AuthMailDeps = {
	// `null` states "no mailer" explicitly; `undefined` resolves from env.
	mailer?: Mailer | null;
	env?: Record<string, string | undefined>;
	// Test seam only. Production detaches the send and nothing awaits it.
	track?: (settled: Promise<void>) => void;
};

export function sendAuthMail(
	kind: AuthMailKind,
	user: { email: string; name?: string | null },
	rawUrl: string,
	deps: AuthMailDeps = {},
): void {
	const env = deps.env ?? process.env;
	const to = user.email;
	if (mailableAddress(to) === null) {
		// The only branch that omits the address from its log line: this one exists
		// for values built to be smuggled somewhere, and the whole reason it fired
		// is that the value is not safe to hand to anything that writes a line.
		console.error(`auth mail: refusing ${kind} mail to a malformed address`);
		return;
	}
	if (isUndeliverableByConstruction(to)) return;

	let mailer: Mailer | null;
	try {
		mailer = deps.mailer === undefined ? mailerFromEnv(env) : deps.mailer;
	} catch (error) {
		console.error("auth mail: SMTP configuration is invalid", error);
		return;
	}
	if (mailer === null) {
		console.warn(
			`auth mail: SMTP is not configured, no ${kind} mail sent to ${to}`,
		);
		return;
	}

	// Translated, so it can be non-ASCII even though no user input reaches it.
	const { subject, text } = compose(kind, {
		name: headerSafe(
			user.name?.trim() || m.auth_mail_greeting_fallback(),
			NAME_MAX,
		),
		url: publicAuthLink(rawUrl, env),
	});

	const settled = mailer
		.send({
			to,
			subject: encodeHeaderValue(headerSafe(subject, SUBJECT_MAX)),
			text,
		})
		.then((result) => {
			if (result.ok) return;
			// Category and reply code only. The server's reply text is remote free
			// text, and the link -- which carries the token -- never goes near a log.
			const code =
				result.failure.smtpCode === undefined
					? ""
					: ` ${result.failure.smtpCode}`;
			console.error(
				`auth mail: ${kind} send to ${to} failed${code}: ${result.failure.category}`,
			);
		})
		.catch((error) => {
			// Narrowed like every other log here: transport.send does not reject, so
			// anything arriving is unclassified and its shape is not known.
			console.error(
				`auth mail: ${kind} send to ${to} threw: ${error instanceof Error ? error.name : "unknown"}`,
			);
		});
	deps.track?.(settled);
}

// Routes whose entire purpose is to put a mail in someone's inbox. With no
// transport they would answer 200 "if this email exists, check your inbox" for
// a mail that cannot be sent -- the worst outcome available, because it leaves
// the user waiting and the operator with nothing to see.
const MAIL_ONLY_PATHS = new Set([
	"/api/auth/request-password-reset",
	"/api/auth/send-verification-email",
]);

export function mailUnavailableResponse(
	request: Request,
	env: Record<string, string | undefined> = process.env,
): Response | null {
	if (request.method !== "POST") return null;
	if (!MAIL_ONLY_PATHS.has(new URL(request.url).pathname)) return null;
	let configured: boolean;
	try {
		configured = mailerFromEnv(env) !== null;
	} catch {
		configured = false;
	}
	if (configured) return null;
	// Address-independent, so it is no enumeration oracle: it reports the state
	// of the deployment, which is the same answer for every caller.
	return new Response(
		JSON.stringify({
			code: "MAIL_NOT_CONFIGURED",
			message: m.auth_mail_not_configured(),
		}),
		{ status: 503, headers: { "content-type": "application/json" } },
	);
}
