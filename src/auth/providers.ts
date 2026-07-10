type ProviderEnv = Partial<
	Record<"GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET", string>
>;

export function socialProvidersFromEnv(env: ProviderEnv) {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		return {};
	}

	return {
		google: {
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
		},
	};
}
