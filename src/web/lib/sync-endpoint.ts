function loopback(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "[::1]" ||
		/^127\./.test(hostname)
	);
}

export function syncEndpointDetail(
	configured: string,
	pageAddress: string,
): {
	address: string;
	problem: "mixed-content" | "localhost" | null;
} | null {
	try {
		const page = new URL(pageAddress);
		const endpoint = new URL(configured, page);
		// Config may contain credentials or tokens. The diagnostic only needs
		// the public endpoint, even when a deployment accidentally includes them.
		endpoint.username = "";
		endpoint.password = "";
		endpoint.search = "";
		endpoint.hash = "";
		const localEndpoint = loopback(endpoint.hostname);
		const problem =
			localEndpoint && !loopback(page.hostname)
				? "localhost"
				: !localEndpoint &&
						page.protocol === "https:" &&
						(endpoint.protocol === "http:" || endpoint.protocol === "ws:")
					? "mixed-content"
					: null;
		return { address: endpoint.href, problem };
	} catch {
		return null;
	}
}
