import {
	DEFAULT_ZERO_URL,
	type PublicConfig,
} from "../../server/public-config.ts";

// Fetched at startup rather than read from import.meta.env: the bundle is built
// once and served from whatever origin the operator runs it on, so a build-time
// zero-cache URL would pin every deployment to the builder's hostname.
export async function fetchPublicConfig(): Promise<PublicConfig> {
	const response = await fetch("/api/config", { credentials: "include" });
	if (!response.ok) throw new Error(`config fetch failed: ${response.status}`);
	const body = (await response.json()) as Partial<PublicConfig>;
	if (!body.zeroURL) throw new Error("config carried no zeroURL");
	return { zeroURL: body.zeroURL };
}

export { DEFAULT_ZERO_URL };
