import type {
	PublicConfig,
	PublicSsoProvider,
} from "../../server/public-config.ts";
import { fetchWithConnectionCheck } from "./connection-required.ts";

// Fetched at startup rather than read from import.meta.env: the bundle is built
// once and served from whatever origin the operator runs it on, so a build-time
// zero-cache URL would pin every deployment to the builder's hostname.
export async function fetchPublicConfig(): Promise<PublicConfig> {
	const response = await fetchWithConnectionCheck("/api/config", {
		credentials: "include",
	});
	if (!response.ok) throw new Error(`config fetch failed: ${response.status}`);
	const body = (await response.json()) as Partial<PublicConfig>;
	if (!body.zeroURL) throw new Error("config carried no zeroURL");
	return {
		zeroURL: body.zeroURL,
		socialProviders: Array.isArray(body.socialProviders)
			? body.socialProviders.filter((provider) => typeof provider === "string")
			: [],
		oidcProviders: Array.isArray(body.oidcProviders)
			? body.oidcProviders.filter(
					(provider) =>
						typeof provider?.id === "string" &&
						typeof provider.name === "string" &&
						typeof provider.icon === "string",
				)
			: [],
		ssoProviders: Array.isArray(body.ssoProviders)
			? body.ssoProviders.filter(
					(provider): provider is PublicSsoProvider =>
						typeof provider?.id === "string" &&
						typeof provider.name === "string" &&
						provider.protocol === "saml",
				)
			: [],
	};
}
