export function validateAuthSecret(env: NodeJS.ProcessEnv = process.env): void {
	if (
		env.NODE_ENV === "production" &&
		(env.BETTER_AUTH_SECRET?.length ?? 0) < 32
	) {
		throw new Error(
			"BETTER_AUTH_SECRET must contain at least 32 characters in production",
		);
	}
}
