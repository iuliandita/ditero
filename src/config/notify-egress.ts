import type { Network } from "../server/client-ip.ts";
import { parseTrustedProxyCIDRs } from "../server/client-ip.ts";

// A /0 allowlist would let a user-supplied notification URL reach anything
// resolvable, private or not -- indistinguishable from having no boundary at
// all. Reject it at boot rather than silently accepting a config that
// defeats the feature it configures.
export function notifyAllowedPrivateCIDRs(value?: string): Network[] {
	const networks = parseTrustedProxyCIDRs(
		(value ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
	if (networks.some(([, prefix]) => prefix === 0)) {
		throw new Error(
			"DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS: a /0 CIDR disables the private-address boundary entirely and is not allowed",
		);
	}
	return networks;
}
