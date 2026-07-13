export type RegistrationMode = "open" | "bootstrap" | "closed";

type RegistrationEnvironment = {
	NODE_ENV?: string;
	DITERO_REGISTRATION_MODE?: string;
};

export function resolveRegistrationMode(
	env: RegistrationEnvironment,
): RegistrationMode {
	const configured = env.DITERO_REGISTRATION_MODE;
	if (!configured) return env.NODE_ENV === "production" ? "bootstrap" : "open";
	if (
		configured === "open" ||
		configured === "bootstrap" ||
		configured === "closed"
	) {
		return configured;
	}
	throw new Error(`Invalid registration mode: ${configured}`);
}

export function assertRegistrationAllowed(
	mode: RegistrationMode,
	userCount: number,
	opts?: { invited?: boolean },
): void {
	if (mode === "open") return;
	// An invitation (email-targeted invite or a server-side provisioning bypass)
	// widens the closed / post-first-user cases. It never narrows: the bootstrap
	// first-user-becomes-owner rule below is reached only when not invited.
	if (opts?.invited === true) return;
	if (mode === "closed") throw new Error("Registration is disabled");
	if (userCount > 0) {
		throw new Error("Registration requires an invitation");
	}
}
