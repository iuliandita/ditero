import ipaddr from "ipaddr.js";

type Address = ipaddr.IPv4 | ipaddr.IPv6;
export type Network = readonly [Address, number];

type ClientIPInput = {
	peerAddress: string;
	forwardedFor: string | null;
	trustedProxies: Network[];
};

function parseAddress(value: string): Address {
	return ipaddr.process(value.trim());
}

function isTrusted(address: Address, networks: Network[]): boolean {
	return networks.some(
		([network, prefix]) =>
			address.kind() === network.kind() && address.match(network, prefix),
	);
}

export function parseTrustedProxyCIDRs(values: string[]): Network[] {
	return values.map((value) => {
		const [address, prefix] = ipaddr.parseCIDR(value.trim());
		if (address.kind() === "ipv6") {
			const ipv6 = address as ipaddr.IPv6;
			if (ipv6.isIPv4MappedAddress()) {
				if (prefix < 96) throw new Error(`Invalid mapped IPv4 CIDR: ${value}`);
				return [ipv6.toIPv4Address(), prefix - 96] as const;
			}
		}
		return [address, prefix] as const;
	});
}

export function trustedProxyCIDRsFromEnv(value?: string): Network[] {
	if (!value) return [];
	return parseTrustedProxyCIDRs(
		value
			.split(",")
			.map((entry) => entry.trim())
			.filter(Boolean),
	);
}

// Returned when the peer address itself cannot be parsed. A throw here would
// surface as a 500 from callers whose whole design is a uniform response (the
// public ack route), which is an oracle; collapsing to one shared key instead
// fails closed for rate-limiting purposes.
export const UNKNOWN_CLIENT_IP = "invalid";

export function resolveClientIP({
	peerAddress,
	forwardedFor,
	trustedProxies,
}: ClientIPInput): string {
	let peer: Address;
	try {
		peer = parseAddress(peerAddress);
	} catch {
		return UNKNOWN_CLIENT_IP;
	}
	if (!forwardedFor || !isTrusted(peer, trustedProxies)) return peer.toString();

	let chain: Address[];
	try {
		chain = forwardedFor.split(",").map(parseAddress);
	} catch {
		return peer.toString();
	}
	chain.push(peer);

	for (let index = chain.length - 1; index >= 0; index -= 1) {
		const address = chain[index];
		if (index === 0 || !isTrusted(address, trustedProxies)) {
			return address.toString();
		}
	}
	return peer.toString();
}

// Rate-limit bucket key for a resolved address. A routed IPv6 allocation is a
// /64 per customer, so keying per-/128 gives one attacker 2^64 buckets and the
// limit bounds nothing. IPv4-mapped forms are canonicalized so ::ffff:1.2.3.4
// and 1.2.3.4 cannot be two buckets for one client.
export function rateLimitKey(address: string): string {
	let parsed: Address;
	try {
		parsed = parseAddress(address);
	} catch {
		return address;
	}
	if (parsed.kind() === "ipv6") {
		const ipv6 = parsed as ipaddr.IPv6;
		if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().toString();
		// Zero the interface identifier: the low 64 bits of the 8 hextets.
		const parts = ipv6.parts.slice(0, 4);
		return `${new ipaddr.IPv6([...parts, 0, 0, 0, 0]).toString()}/64`;
	}
	return parsed.toString();
}

export function sanitizeAuthRequest(
	request: Request,
	peerAddress: string | undefined,
	trustedProxies: Network[],
): Request {
	const headers = new Headers(request.headers);
	const forwardedFor = headers.get("x-forwarded-for");
	for (const name of [
		"forwarded",
		"x-forwarded-for",
		"x-real-ip",
		"cf-connecting-ip",
		"x-client-ip",
		"x-ditero-client-ip",
	]) {
		headers.delete(name);
	}
	if (peerAddress) {
		headers.set(
			"x-ditero-client-ip",
			resolveClientIP({ peerAddress, forwardedFor, trustedProxies }),
		);
	}
	return new Request(request, { headers });
}
