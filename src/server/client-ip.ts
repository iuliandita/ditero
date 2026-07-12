import ipaddr from "ipaddr.js";

type Address = ipaddr.IPv4 | ipaddr.IPv6;
type Network = readonly [Address, number];

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

export function resolveClientIP({
	peerAddress,
	forwardedFor,
	trustedProxies,
}: ClientIPInput): string {
	const peer = parseAddress(peerAddress);
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
