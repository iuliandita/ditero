import { createHash, timingSafeEqual } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { OAuthProvider } from "better-auth/oauth2";
import { apple } from "better-auth/social-providers";
import { jwtVerify } from "jose";

type SocialProvider = {
	id: string;
	options?: Record<string, unknown>;
	[key: string]: unknown;
};

type IdTokenConfig = {
	jwks: Parameters<typeof jwtVerify>[1];
	issuer?: string;
	audience?: string | string[];
	algorithms?: string[];
	maxTokenAge?: string;
	nonceComparison?: "exact" | "exact-or-sha256";
	verifyClaims?: (claims: Record<string, unknown>) => boolean;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest();

// Equal-length digests keep the comparison constant time. Apple may answer with
// the hex SHA-256 of the nonce, as Better Auth's own Apple verifier accepts.
function nonceMatches(
	claim: unknown,
	nonce: string,
	comparison: IdTokenConfig["nonceComparison"],
): boolean {
	if (typeof claim !== "string") return false;
	const got = sha256(claim);
	if (timingSafeEqual(got, sha256(nonce))) return true;
	return (
		comparison === "exact-or-sha256" &&
		timingSafeEqual(got, sha256(sha256(nonce).toString("hex")))
	);
}

// Better Auth's Microsoft and Apple providers decode the ID token from the token
// endpoint without checking it. Run the checks their own sign-in-by-token path
// uses (signature, issuer, audience, age, tenant binding) on the code flow too,
// and bind the token to the nonce stored with this authorization's state.
async function idTokenIsValid(
	config: IdTokenConfig | undefined,
	idToken: string | undefined,
	nonce: string | undefined,
): Promise<boolean> {
	if (!config || !idToken || !nonce) return false;
	try {
		const { payload } = await jwtVerify(idToken, config.jwks as never, {
			issuer: config.issuer,
			audience: config.audience,
			algorithms: config.algorithms,
			maxTokenAge: config.maxTokenAge,
			requiredClaims: ["iss", "sub", "aud", "exp", "iat"],
			clockTolerance: 30,
		});
		return (
			nonceMatches(payload.nonce, nonce, config.nonceComparison) &&
			(config.verifyClaims?.(payload) ?? true)
		);
	} catch {
		return false;
	}
}

function requireVerifiedIdToken(provider: SocialProvider): SocialProvider {
	const authorize =
		provider.createAuthorizationURL as OAuthProvider["createAuthorizationURL"];
	const getUserInfo = provider.getUserInfo as (token: {
		idToken?: string;
		expectedIdTokenNonce?: string;
	}) => Promise<unknown>;
	return {
		...provider,
		requiresIdTokenNonce: true,
		async createAuthorizationURL(data: Parameters<typeof authorize>[0]) {
			if (!data.idTokenNonce) throw new Error("ID token nonce is required");
			const url = await authorize(data);
			url.searchParams.set("nonce", data.idTokenNonce);
			return url;
		},
		async getUserInfo(token: {
			idToken?: string;
			expectedIdTokenNonce?: string;
		}) {
			if (
				!(await idTokenIsValid(
					provider.idToken as IdTokenConfig,
					token.idToken,
					token.expectedIdTokenNonce,
				))
			)
				return null;
			return getUserInfo(token);
		},
	};
}

// Sign-in by a client-submitted ID token is a second door that Ditero's own
// clients never use (browsers and native apps go through the code flow), so
// it stays closed for the providers added here. Google keeps its prior behavior.
function withoutIdTokenSignIn(provider: SocialProvider): SocialProvider {
	return provider.id === "google"
		? provider
		: {
				...provider,
				options: { ...provider.options, disableIdTokenSignIn: true },
			};
}

const text = (value: unknown): string | undefined =>
	typeof value === "string" && value !== "" ? value : undefined;

// Adjusts built-in providers where their defaults do not fit Ditero's identity
// rules. Runs after genericOAuth so the replaced list keeps the OIDC providers.
export function signInProviderPlugin(options: {
	appleSecret?: () => string;
}): BetterAuthPlugin {
	return {
		id: "ditero-sign-in-providers",
		hooks: {
			before: [
				{
					matcher: (context) =>
						(context.path === "/sign-in/social" ||
							context.path === "/link-social") &&
						context.body?.provider !== "google" &&
						Boolean(context.body?.idToken),
					handler: createAuthMiddleware(async () => {
						// Also covers OIDC providers registered after discovery recovers.
						throw new APIError("BAD_REQUEST", {
							code: "ID_TOKEN_NOT_SUPPORTED",
							message: "Use the provider authorization code flow",
						});
					}),
				},
			],
		},
		init(context) {
			const providers = (context.socialProviders as unknown as SocialProvider[])
				.map((provider): SocialProvider => {
					if (provider.id === "microsoft")
						// Object IDs are only unique inside one tenant, so the tenant is part
						// of the identity. Multi-tenant modes admit many tenants.
						return {
							...requireVerifiedIdToken(provider),
							accountSubject: ({
								profile,
							}: {
								profile: Record<string, unknown>;
							}) => {
								const tid = text(profile.tid);
								const oid = text(profile.oid);
								if (!tid || !oid)
									throw new Error(
										"Microsoft token carries no tenant and object ID",
									);
								return `${tid}:${oid}`;
							},
						};
					if (provider.id === "facebook") {
						const getUserInfo = provider.getUserInfo as (
							token: unknown,
						) => Promise<{ user: Record<string, unknown> } | null>;
						// Facebook's email is whatever the user typed into the account and is not
						// a verified claim, so it can never invite or link.
						return {
							...provider,
							async getUserInfo(token: unknown) {
								const result = await getUserInfo(token);
								return (
									result && {
										...result,
										user: { ...result.user, emailVerified: false },
									}
								);
							},
						};
					}
					if (provider.id === "apple" && options.appleSecret) {
						const secret = options.appleSecret;
						const fresh = () =>
							apple({ ...provider.options, clientSecret: secret() } as never);
						return {
							...requireVerifiedIdToken(provider),
							validateAuthorizationCode: (data: never) =>
								fresh().validateAuthorizationCode(data),
							refreshAccessToken: (token: string) =>
								fresh().refreshAccessToken?.(token) as never,
						};
					}
					return provider;
				})
				.map(withoutIdTokenSignIn);
			return { context: { socialProviders: providers as never } };
		},
	};
}
