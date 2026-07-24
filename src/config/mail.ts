import { booleanFlag, positiveInt } from "./env.ts";

// Operator configuration, never per user (design 3.3): a user-supplied SMTP
// host would be an SSRF primitive, and safe-http.ts has no SMTP equivalent to
// defend it with. The only per-user part of the email channel is the
// destination address.
export type MailConfig = {
	host: string;
	port: number;
	// Implicit TLS from the first byte (SMTPS, port 465). False means the
	// connection opens in cleartext and must be upgraded with STARTTLS.
	implicitTls: boolean;
	// Refuse to continue on a connection STARTTLS did not secure. The whole
	// point of the flag: without it a server that simply omits STARTTLS from its
	// EHLO gets the AUTH credentials in cleartext, and nothing looks wrong.
	requireTls: boolean;
	auth: { user: string; password: string } | null;
	from: string;
};

export const DEFAULT_SMTP_PORT = 587;
export const IMPLICIT_TLS_PORT = 465;

// Every setting that only makes sense with a host. Set without one, they are a
// misconfiguration that would otherwise disable mail silently -- the exact
// failure a self-hoster cannot debug from the outside.
const DEPENDENT_KEYS = [
	"DITERO_SMTP_PORT",
	"DITERO_SMTP_USER",
	"DITERO_SMTP_PASSWORD",
	"DITERO_SMTP_FROM",
	"DITERO_SMTP_SECURE",
	"DITERO_SMTP_ALLOW_INSECURE",
] as const;

// A header value, so a CR/LF in it is header injection -- from operator config
// rather than from a user, but the transport builds the From header from it and
// the cost of checking is nil. Display-name form ("Ditero <a@b.example>") is
// accepted; an address must be present either way.
function requireFrom(raw: string | undefined): string {
	const value = raw?.trim();
	if (!value) {
		throw new Error(
			"DITERO_SMTP_FROM is required when DITERO_SMTP_HOST is set: mail with no envelope sender is rejected by most servers",
		);
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to reject them
	if (/[\x00-\x1f\x7f]/.test(value) || !/.@./.test(value)) {
		throw new Error(
			"DITERO_SMTP_FROM must be an email address with no control characters",
		);
	}
	return value;
}

function requireAuth(
	env: Record<string, string | undefined>,
): { user: string; password: string } | null {
	const user = env.DITERO_SMTP_USER?.trim();
	// Not trimmed: a password may legitimately begin or end with a space, and
	// silently sending a different one than the operator set is worse than a
	// stray space.
	const password = env.DITERO_SMTP_PASSWORD;
	if (!user && !password) return null;
	if (!user || !password) {
		throw new Error(
			"DITERO_SMTP_USER and DITERO_SMTP_PASSWORD must be set together",
		);
	}
	return { user, password };
}

// Null means "no SMTP configured": the email channel is disabled and invite and
// auth mail have nowhere to go, but the process still starts. A self-hoster with
// no mail server must be able to run the app.
export function mailConfig(
	env: Record<string, string | undefined>,
): MailConfig | null {
	const host = env.DITERO_SMTP_HOST?.trim();
	if (!host) {
		const stray = DEPENDENT_KEYS.filter((key) => env[key]?.trim());
		if (stray.length > 0) {
			throw new Error(
				`${stray.join(", ")} set without DITERO_SMTP_HOST: mail would be silently disabled`,
			);
		}
		return null;
	}

	const port = positiveInt(
		"DITERO_SMTP_PORT",
		env.DITERO_SMTP_PORT,
		DEFAULT_SMTP_PORT,
	);
	if (port > 65_535) {
		throw new Error(`DITERO_SMTP_PORT: ${port} is not a port`);
	}
	const implicitTls = booleanFlag(
		"DITERO_SMTP_SECURE",
		env.DITERO_SMTP_SECURE,
		port === IMPLICIT_TLS_PORT,
	);
	const allowInsecure = booleanFlag(
		"DITERO_SMTP_ALLOW_INSECURE",
		env.DITERO_SMTP_ALLOW_INSECURE,
		false,
	);
	if (implicitTls && allowInsecure) {
		// Name where implicit TLS came from: on 465 it is the port default, and
		// blaming a variable the operator never set sends them looking for it.
		const source = env.DITERO_SMTP_SECURE?.trim()
			? "DITERO_SMTP_SECURE=true"
			: `implicit TLS implied by DITERO_SMTP_PORT=${port}`;
		throw new Error(
			`DITERO_SMTP_ALLOW_INSECURE cannot be combined with ${source}`,
		);
	}

	return {
		host,
		port,
		implicitTls,
		// TLS is the default and the opt-out is explicit: an operator who has to
		// name DITERO_SMTP_ALLOW_INSECURE has decided that this hop is a local
		// relay. Anything less deliberate leaks the SMTP password on the wire.
		requireTls: !implicitTls && !allowInsecure,
		auth: requireAuth(env),
		from: requireFrom(env.DITERO_SMTP_FROM),
	};
}

export function isMailConfigured(
	env: Record<string, string | undefined>,
): boolean {
	return mailConfig(env) !== null;
}
