type PasskeyEnvironment = {
	BETTER_AUTH_URL?: string;
	DITERO_PASSKEY_RP_ID?: string;
	DITERO_PASSKEY_ORIGIN?: string;
};

export function authRateLimitOptions() {
	const options = {
		enabled: true,
		storage: "database" as const,
		window: 60,
		max: 100,
		customRules: {
			"/sign-in/email": { window: 60, max: 5 },
			"/sign-up/email": { window: 60, max: 5 },
			"/request-password-reset": { window: 300, max: 3 },
			"/reset-password": { window: 300, max: 5 },
			"/change-password": { window: 300, max: 5 },
			"/two-factor/*": { window: 60, max: 5 },
			"/passkey/*": { window: 60, max: 10 },
		},
	};
	// Relax the signup/signin ceiling under the e2e harness only: its multi-context
	// matrix signs up many users per minute from one loopback IP. Prod keeps 5/60s.
	// Gated on DITERO_E2E, not NODE_ENV=test — the security unit test and the
	// auth-hardening integration test both run under NODE_ENV=test and assert the
	// strict limits, so keying off NODE_ENV would break them.
	if (process.env.DITERO_E2E === "1") {
		options.customRules["/sign-in/email"] = { window: 60, max: 1000 };
		options.customRules["/sign-up/email"] = { window: 60, max: 1000 };
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
