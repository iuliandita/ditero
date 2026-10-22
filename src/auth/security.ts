import { createHash } from "node:crypto";
import { rateLimitKey } from "../server/client-ip.ts";

export const SIGN_IN_RATE_CAPACITY = 5;
export const SIGN_IN_RATE_REFILL_PER_SEC = 5 / 60;
export const SIGN_IN_BODY_LIMIT = 4096;

export function signInRateKey(clientIP: string, email: string): string {
	return `auth:sign-in:${createHash("sha256")
		.update(
			JSON.stringify([rateLimitKey(clientIP), email.trim().toLowerCase()]),
		)
		.digest("hex")}`;
}

// Read only a bounded clone; Better Auth still needs the original body.
export async function readSignInEmail(
	request: Request,
): Promise<string | null> {
	if (
		request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !==
		"application/json"
	)
		return null;
	const clone = request.clone();
	const reader = clone.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > SIGN_IN_BODY_LIMIT) return null;
			chunks.push(value);
		}
		const body: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
		);
		if (
			typeof body !== "object" ||
			body === null ||
			!("email" in body) ||
			typeof body.email !== "string"
		)
			return null;
		const email = body.email.trim().toLowerCase();
		return email.length > 0 && email.length <= 320 ? email : null;
	} catch {
		return null;
	} finally {
		// Awaiting cancellation of one tee branch can wait for the unread original.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

type PasskeyEnvironment = {
	BETTER_AUTH_URL?: string;
	DITERO_PASSKEY_RP_ID?: string;
	DITERO_PASSKEY_ORIGIN?: string;
};

export function authRateLimitOptions() {
	const customRules: Record<string, { window: number; max: number }> = {
		"/sign-in/email": { window: 60, max: 30 },
		"/sign-up/email": { window: 60, max: 10 },
		"/get-session": { window: 60, max: 600 },
		"/token": { window: 60, max: 600 },
		"/request-password-reset": { window: 300, max: 3 },
		"/reset-password": { window: 300, max: 5 },
		"/change-password": { window: 300, max: 5 },
		"/two-factor/*": { window: 60, max: 30 },
		// Each start writes AuthnRequest and RelayState rows, and each callback
		// parses and verifies signed XML, so both stay well below the default.
		"/sign-in/sso": { window: 60, max: 20 },
		"/sso/saml2/sp/acs/*": { window: 60, max: 30 },
		// Listed BEFORE "/passkey/*": Better Auth resolves customRules with
		// Object.keys(...).find(...), so the first matching key in insertion order
		// wins and a wildcard placed first would swallow this exact path.
		//
		// The ceremony endpoints stay at 10/60s, but listing your own passkeys is a
		// session-scoped read with no abuse surface, and SecurityPanel refetches it
		// on every mount -- it sits on the desktop lists index, i.e. the app's
		// landing surface -- so the ceremony ceiling throttled ordinary navigation
		// and, worse, could 429 the refresh that runs right after a SUCCESSFUL
		// enrollment, leaving the new passkey invisible.
		"/passkey/list-user-passkeys": { window: 60, max: 100 },
		"/passkey/*": { window: 60, max: 10 },
	};
	const options = {
		enabled: true,
		storage: "database" as const,
		window: 60,
		max: 100,
		customRules,
	};
	// Relax the signup/signin ceiling under the e2e harness only: its multi-context
	// matrix signs up many users per minute from one loopback IP.
	// Gated on DITERO_E2E, not NODE_ENV=test — the security unit test and the
	// auth-hardening integration test both run under NODE_ENV=test and assert the
	// strict limits, so keying off NODE_ENV would break them.
	if (process.env.DITERO_E2E === "1") {
		options.customRules["/sign-in/email"] = { window: 60, max: 1000 };
		options.customRules["/sign-up/email"] = { window: 60, max: 1000 };
		// The views e2e resolves the signed-in user via a get-session round-trip;
		// relax it here (test-only) so a poll loop does not trip the 600/60s limit.
		options.customRules["/get-session"] = { window: 60, max: 1000 };
		// Zero refreshes its JWT via /token; under accumulated suite load the warm
		// files can exceed 600/60s and surface as "token refresh failed: 429".
		options.customRules["/token"] = { window: 60, max: 1000 };
	}
	return options;
}

export function passkeyOptions(env: PasskeyEnvironment) {
	const origin = new URL(env.BETTER_AUTH_URL ?? "http://localhost:3000");
	return {
		rpID: env.DITERO_PASSKEY_RP_ID ?? origin.hostname,
		rpName: "Ditero",
		origin: env.DITERO_PASSKEY_ORIGIN ?? origin.origin,
	};
}

export function requireSameOrigin(
	request: Request,
	allowedOrigins: string | string[],
): void {
	const allowed = (
		Array.isArray(allowedOrigins) ? allowedOrigins : [allowedOrigins]
	).map((value) => new URL(value).origin);
	if (!allowed.includes(request.headers.get("origin") ?? "")) {
		throw new Error("Request origin is not trusted");
	}
}
