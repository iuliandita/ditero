// Shared by the server and the web client: no Node imports.
export const BUILTIN_PROVIDER_IDS = [
	"google",
	"microsoft",
	"github",
	"discord",
	"apple",
	"facebook",
] as const;
export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number];

// Proper nouns: never translated.
export const BUILTIN_PROVIDER_NAMES: Record<BuiltinProviderId, string> = {
	google: "Google",
	microsoft: "Microsoft",
	github: "GitHub",
	discord: "Discord",
	apple: "Apple",
	facebook: "Facebook",
};

export const OIDC_ICONS = [
	"key",
	"shield",
	"building",
	"users",
	"server",
	"cloud",
] as const;
export type OidcIcon = (typeof OIDC_ICONS)[number];

export type SignInProviderOption = {
	id: string;
	name: string;
	icon: OidcIcon | null;
};
