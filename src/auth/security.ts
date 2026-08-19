type PasskeyEnvironment = {
	BETTER_AUTH_URL?: string;
	DITERO_PASSKEY_RP_ID?: string;
	DITERO_PASSKEY_ORIGIN?: string;
};

export function authRateLimitOptions() {
	const customRules: Record<string, { window: number; max: number }> = {
		"/sign-in/email": { window: 60, max: 5 },
		"/sign-up/email": { window: 60, max: 5 },
		"/request-password-reset": { window: 300, max: 3 },
		"/reset-password": { window: 300, max: 5 },
		"/change-password": { window: 300, max: 5 },
		"/two-factor/*": { window: 60, max: 5 },
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
	// matrix signs up many users per minute from one loopback IP. Prod keeps 5/60s.
	// Gated on DITERO_E2E, not NODE_ENV=test — the security unit test and the
	// auth-hardening integration test both run under NODE_ENV=test and assert the
	// strict limits, so keying off NODE_ENV would break them.
	if (process.env.DITERO_E2E === "1") {
		options.customRules["/sign-in/email"] = { window: 60, max: 1000 };
		options.customRules["/sign-up/email"] = { window: 60, max: 1000 };
		// The views e2e resolves the signed-in user via a get-session round-trip;
		// relax it here (test-only) so a poll loop does not trip the default 100/60s
		// limiter mid-run. Prod keeps the default limit — never relaxed outside e2e.
		options.customRules["/get-session"] = { window: 60, max: 1000 };
		// Zero refreshes its JWT via /token; under accumulated suite load the warm
		// files can exceed the default 100/60s and surface as "token refresh failed:
		// 429". Test-only relaxation; prod keeps the default limit.
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
