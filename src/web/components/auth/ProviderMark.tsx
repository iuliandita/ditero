import {
	Building2,
	Cloud,
	KeyRound,
	LogIn,
	Server,
	ShieldCheck,
	Users,
} from "lucide-react";
import type { SignInProviderOption } from "../../../auth/provider-names.ts";
import { GoogleMark } from "./GoogleMark.tsx";

// Four-square Microsoft logo: brand guidelines ask for the exact colours.
function MicrosoftMark() {
	return (
		<svg
			viewBox="0 0 21 21"
			aria-hidden="true"
			focusable="false"
			xmlns="http://www.w3.org/2000/svg"
		>
			<rect x="1" y="1" width="9" height="9" fill="#F25022" />
			<rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
			<rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
			<rect x="11" y="11" width="9" height="9" fill="#FFB900" />
		</svg>
	);
}

const OIDC_ICON_COMPONENTS = {
	key: KeyRound,
	shield: ShieldCheck,
	building: Building2,
	users: Users,
	server: Server,
	cloud: Cloud,
};

export function ProviderMark({ provider }: { provider: SignInProviderOption }) {
	if (provider.icon !== null) {
		const Icon = OIDC_ICON_COMPONENTS[provider.icon];
		return <Icon aria-hidden="true" />;
	}
	if (provider.id === "google") return <GoogleMark />;
	if (provider.id === "microsoft") return <MicrosoftMark />;
	return <LogIn aria-hidden="true" />;
}
