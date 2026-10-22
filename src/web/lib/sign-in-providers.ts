import {
	BUILTIN_PROVIDER_IDS,
	BUILTIN_PROVIDER_NAMES,
	OIDC_ICONS,
	type OidcIcon,
	type SignInProviderOption,
} from "../../auth/provider-names.ts";
import type { PublicConfig } from "../../server/public-config.ts";

// Built-in providers first in a fixed order, then operator-defined OIDC
// providers in the order the server lists them. The client trusts only names
// it can render: an unknown icon falls back to the generic key.
export function signInProviderOptions(
	config: Pick<PublicConfig, "socialProviders" | "oidcProviders">,
): SignInProviderOption[] {
	const enabled = new Set(config.socialProviders ?? []);
	const builtin = BUILTIN_PROVIDER_IDS.filter((id) => enabled.has(id)).map(
		(id) => ({ id, name: BUILTIN_PROVIDER_NAMES[id], icon: null }),
	);
	const oidc = (config.oidcProviders ?? [])
		.filter((provider) => enabled.has(provider.id))
		.map((provider) => ({
			id: provider.id,
			name: provider.name,
			icon: (OIDC_ICONS as readonly string[]).includes(provider.icon)
				? (provider.icon as OidcIcon)
				: ("key" as const),
		}));
	return [...builtin, ...oidc];
}
