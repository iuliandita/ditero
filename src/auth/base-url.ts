type AuthEnvironment = {
	NODE_ENV?: string;
	BETTER_AUTH_URL?: string;
	DITERO_PUBLIC_URL?: string;
};

export function authBaseURL(env: AuthEnvironment): string {
	const configured = env.BETTER_AUTH_URL ?? env.DITERO_PUBLIC_URL;
	if (configured === undefined) {
		if (env.NODE_ENV === "production")
			throw new Error(
				"BETTER_AUTH_URL or DITERO_PUBLIC_URL is required in production",
			);
		return "http://localhost:3000";
	}
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		throw new Error("Auth base URL must be an HTTP or HTTPS origin");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error("Auth base URL must be an HTTP or HTTPS origin");
	return url.origin;
}
