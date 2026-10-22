export function signInReturnPath(value: string | null, origin: string): string {
	if (!value) return "/";
	try {
		const url = new URL(value, origin);
		if (
			url.origin !== origin ||
			url.pathname.startsWith("//") ||
			url.pathname.startsWith("/api/") ||
			url.pathname.replace(/\/+$/, "") === "/two-factor"
		)
			return "/";
		return url.pathname + url.search + url.hash;
	} catch {
		return "/";
	}
}
