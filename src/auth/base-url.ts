type AuthEnvironment = {
	NODE_ENV?: string;
	BETTER_AUTH_URL?: string;
	DITERO_PUBLIC_URL?: string;
};

export function authBaseURL(env: AuthEnvironment): string {
	const name = env.BETTER_AUTH_URL?.trim()
		? "BETTER_AUTH_URL"
		: "DITERO_PUBLIC_URL";
	const configured = env[name]?.trim() ? env[name] : undefined;
	if (configured === undefined) {
		if (env.NODE_ENV === "production")
			throw new Error(
				"BETTER_AUTH_URL or DITERO_PUBLIC_URL is required in production",
			);
		return "http://localhost:3000";
	}
	const invalid = () =>
		new Error(
			`${name}=${JSON.stringify(configured)} must be an HTTP or HTTPS origin without credentials, path, query or fragment`,
		);
	let url: URL;
	try {
		url = new URL(configured);
	} catch {
		throw invalid();
	}
	if (
		configured !== configured.trim() ||
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw invalid();
	return url.origin;
}
