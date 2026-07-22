import { networkInterfaces } from "node:os";

// Any notification tap this repo stands up (the e2e ntfy stub, the integration
// replica rig) has to bind somewhere the app's SSRF boundary can be taught to
// reach: safe-http refuses 127.0.0.0/8 unconditionally and no allowlist may
// re-enable it. A real private interface -- the docker bridge, which every
// machine running these suites has -- is the only option.
//
// RFC1918 only. `startsWith("172.")` would also match 172.32-172.255, which are
// PUBLIC -- and this address is fed straight into the API's private-CIDR
// allowlist, so a wrong match widens the SSRF policy rather than just picking a
// bad interface. No fallback to "any interface at all" for the same reason.
export function isPrivateIPv4(address: string): boolean {
	const octets = address.split(".").map(Number);
	if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n))) {
		return false;
	}
	const [a, b] = octets;
	if (a === 10) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	return false;
}

export function privateHost(): string {
	const candidates = Object.values(networkInterfaces())
		.flat()
		.filter((i) => i && i.family === "IPv4" && !i.internal)
		.map((i) => (i as { address: string }).address)
		.filter(isPrivateIPv4);
	// Prefer the docker bridge: these suites already require docker, and that
	// interface is host-local, so the tap is not reachable from the LAN.
	const host =
		candidates.find((a) => a.startsWith("172.")) ?? candidates[0] ?? null;
	if (!host) {
		throw new Error(
			"tests: no private non-loopback IPv4 for the notification tap. The SSRF " +
				"boundary refuses loopback unconditionally, so the tap needs a " +
				"private interface (a docker bridge is enough).",
		);
	}
	return host;
}
