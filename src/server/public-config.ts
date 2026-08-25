// The web bundle is built once and served from whatever origin the operator
// runs it on, so the zero-cache URL cannot be baked into it: a single published
// image would only ever work at the build's hostname. It is resolved here at
// request time from the same environment variable that drives the CSP, so the
// address the client dials and the address the CSP permits cannot drift.
export const DEFAULT_ZERO_URL = "http://localhost:4848";

export type PublicEnvironment = Record<string, string | undefined>;

export function zeroPublicURL(env: PublicEnvironment): string {
	return env.PUBLIC_ZERO_URL || DEFAULT_ZERO_URL;
}

export type PublicConfig = {
	zeroURL: string;
};

export function publicConfig(env: PublicEnvironment): PublicConfig {
	return { zeroURL: zeroPublicURL(env) };
}
