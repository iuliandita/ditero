type PasskeyEnvironment = {
	BETTER_AUTH_URL?: string;
	DITERO_PASSKEY_RP_ID?: string;
	DITERO_PASSKEY_ORIGIN?: string;
};

export function authRateLimitOptions() {
	return {
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
