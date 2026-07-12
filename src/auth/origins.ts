type OriginEnvironment = {
	NODE_ENV?: string;
	TRUSTED_ORIGINS?: string;
};

export function trustedAuthOrigins(env: OriginEnvironment): string[] {
	if (!env.TRUSTED_ORIGINS) {
		return env.NODE_ENV === "production" ? [] : ["http://localhost:5173"];
	}

	return env.TRUSTED_ORIGINS.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
}
