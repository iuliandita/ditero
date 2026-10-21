import { type GenericOAuthConfig, genericOAuth } from "better-auth/plugins";
import { createAppleSecretSource } from "./apple-secret.ts";
import { oidcConfigs } from "./oidc.ts";
import {
	type MicrosoftTenant,
	nodeProviderIO,
	type ProviderEnvironment,
	type ProviderIO,
	type ProviderSettings,
	type PublicSignInProvider,
	publicSignInProviders,
	readProviderSettings,
	structureOnlyIO,
} from "./provider-env.ts";
import { signInProviderPlugin } from "./provider-plugin.ts";

export const APPLE_ORIGIN = "https://appleid.apple.com";

function microsoftTenantId(tenant: MicrosoftTenant): string {
	return tenant.mode === "tenant" ? tenant.id : tenant.mode;
}

export function socialProviderOptions(
	settings: ProviderSettings,
	appleSecret?: () => string,
) {
	const social: Record<string, Record<string, unknown>> = {};
	if (settings.google)
		social.google = {
			clientId: settings.google.clientId,
			clientSecret: settings.google.clientSecret,
		};
	if (settings.github)
		social.github = {
			clientId: settings.github.clientId,
			clientSecret: settings.github.clientSecret,
		};
	if (settings.discord)
		social.discord = {
			clientId: settings.discord.clientId,
			clientSecret: settings.discord.clientSecret,
		};
	if (settings.facebook)
		social.facebook = {
			clientId: settings.facebook.clientId,
			clientSecret: settings.facebook.clientSecret,
		};
	if (settings.microsoft)
		// openid, profile and email need no admin consent; the default User.Read and
		// offline_access scopes, and the Graph photo lookup they enable, are not used.
		social.microsoft = {
			clientId: settings.microsoft.clientId,
			clientSecret: settings.microsoft.clientSecret,
			tenantId: microsoftTenantId(settings.microsoft.tenant),
			disableDefaultScope: true,
			scope: ["openid", "profile", "email"],
			disableProfilePhoto: true,
		};
	if (settings.apple && appleSecret)
		social.apple = {
			clientId: settings.apple.clientId,
			clientSecret: appleSecret(),
		};
	return social;
}

export type SignInProviders = {
	settings: ProviderSettings;
	socialProviders: Record<string, Record<string, unknown>>;
	oidc: GenericOAuthConfig[];
	appleSecret?: () => string;
	ids: string[];
};

export function resolveSignInProviders(
	env: ProviderEnvironment,
	io: ProviderIO = nodeProviderIO,
): SignInProviders {
	const settings = readProviderSettings(env, io);
	const appleSecret = settings.apple
		? createAppleSecretSource(settings.apple, io)
		: undefined;
	// Fail at startup on an unreadable or malformed Apple key, not at first login.
	appleSecret?.();
	const socialProviders = socialProviderOptions(settings, appleSecret);
	return {
		settings,
		socialProviders,
		oidc: oidcConfigs(settings.oidc),
		appleSecret,
		ids: [...Object.keys(socialProviders), ...settings.oidc.map((p) => p.id)],
	};
}

export function socialProvidersFromEnv(
	env: ProviderEnvironment,
	io: ProviderIO = nodeProviderIO,
) {
	return resolveSignInProviders(env, io).socialProviders;
}

export function publicProvidersFromEnv(
	env: ProviderEnvironment,
): PublicSignInProvider[] {
	return publicSignInProviders(readProviderSettings(env, structureOnlyIO));
}

// The Better Auth options that make the configured providers behave the Ditero
// way. Shared by the server and its provider tests so both run the same wiring.
export function providerAuthOptions(signIn: SignInProviders) {
	return {
		trustedOrigins: signIn.settings.apple ? [APPLE_ORIGIN] : [],
		account: {
			accountLinking: {
				enabled: true,
				// A provider's email never attaches a sign-in to an existing account.
				// Linking is an explicit action by the signed-in owner, who may link a
				// provider whose email differs (relay addresses, work accounts).
				disableImplicitLinking: true,
				allowDifferentEmails: true,
				trustedProviders: signIn.ids,
			},
		},
		socialProviders: signIn.socialProviders,
		plugins: [
			...(signIn.oidc.length > 0
				? [genericOAuth({ config: signIn.oidc })]
				: []),
			signInProviderPlugin({ appleSecret: signIn.appleSecret }),
		],
	};
}

// Apple returns to the callback with a cross-site form POST from its own
// origin. Only that one route accepts that origin.
export function acceptedAuthOrigins(
	request: Request,
	origins: string[],
	appleEnabled: boolean,
): string[] {
	const appleCallback =
		request.method === "POST" &&
		new URL(request.url).pathname === "/api/auth/callback/apple";
	return appleEnabled && appleCallback ? [...origins, APPLE_ORIGIN] : origins;
}
