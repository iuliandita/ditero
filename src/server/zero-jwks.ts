import { createRemoteJWKSet, customFetch } from "jose";

export function createFirstPartyJWKSet(
	url: URL,
	handler: (request: Request) => Promise<Response>,
) {
	// The public issuer can be unreachable from its own container. Keep JOSE's
	// refresh/cache policy while routing only this first-party endpoint locally.
	return createRemoteJWKSet(url, {
		[customFetch]: (requestedUrl, options) => {
			if (requestedUrl !== url.href)
				throw new Error("Unexpected first-party JWKS URL");
			return handler(new Request(requestedUrl, options));
		},
	});
}
