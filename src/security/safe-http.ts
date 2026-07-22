import { resolve4, resolve6 } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector, request } from "undici";
import type { Network } from "../server/client-ip.ts";

// A request refused by policy before or during transfer -- blocked address,
// disallowed protocol, URL credentials, oversized response. Callers must be
// able to tell these from a transport failure without matching on message
// strings: the notification worker treats them as permanently undeliverable
// (C17), where a transport error is retried with backoff. Retrying a refusal
// burns the whole ladder on a channel that can never succeed, and re-probes an
// SSRF target on every attempt.
export class OutboundPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutboundPolicyError";
	}
}

type Resolver = {
	resolve4: (hostname: string) => Promise<string[]>;
	resolve6: (hostname: string) => Promise<string[]>;
};

type SafeFetchOptions = {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: HeadersInit;
	body?: string | Uint8Array;
	signal?: AbortSignal;
	maxResponseBytes?: number;
	allowedPrivateCIDRs?: readonly Network[];
};

// Encodings that hide a private/loopback address inside an otherwise-unicast
// IPv6 literal. ipaddr.js only unwraps the ipv4-mapped/compatible forms (via
// `process`); these transition encodings keep their embedded IPv4 payload
// hidden from `range()`, so they must be rejected on the raw parsed address,
// before any allowlist check, and regardless of how the embedded address
// would otherwise be classified.
const transitionNetworks = [
	[ipaddr.parse("64:ff9b::"), 96],
	[ipaddr.parse("64:ff9b:1::"), 48],
	[ipaddr.parse("2001::"), 32],
	[ipaddr.parse("2002::"), 16],
] as const;

// Ranges an operator allowlist may never re-enable: reaching these from a
// user-supplied URL is always an attack, never a self-hosted deployment.
// IPv6 unique-local (fc00::/7) is deliberately absent -- it is the IPv6
// analogue of RFC1918 private space and a legitimate self-hosted target.
const neverAllowed = [
	[ipaddr.parse("0.0.0.0"), 8], // RFC5735 "this network"
	[ipaddr.parse("127.0.0.0"), 8], // loopback
	[ipaddr.parse("169.254.0.0"), 16], // link-local, incl. cloud metadata 169.254.169.254
	[ipaddr.parse("100.64.0.0"), 10], // CGNAT shared address space
	[ipaddr.parse("224.0.0.0"), 4], // multicast
	[ipaddr.parse("255.255.255.255"), 32], // limited broadcast
	[ipaddr.parse("::1"), 128], // loopback
	[ipaddr.parse("::"), 128], // unspecified
	[ipaddr.parse("fe80::"), 10], // link-local
	[ipaddr.parse("ff00::"), 8], // multicast
] as const;

function normalizedHostname(value: string): string {
	return value.startsWith("[") && value.endsWith("]")
		? value.slice(1, -1)
		: value;
}

function matchesAny(
	address: ipaddr.IPv4 | ipaddr.IPv6,
	networks: readonly Network[],
): boolean {
	return networks.some(
		([network, prefix]) =>
			address.kind() === network.kind() && address.match(network, prefix),
	);
}

// Runs every non-relaxable check and returns the normalized address. No
// allowlist is in scope here, so a future editor cannot accidentally let an
// allowlist short-circuit these checks -- there is nothing to short-circuit.
function assertNotForbidden(value: string): ipaddr.IPv4 | ipaddr.IPv6 {
	const hostname = normalizedHostname(value);
	const parsed = ipaddr.parse(hostname);
	if (parsed.kind() === "ipv6" && matchesAny(parsed, transitionNetworks)) {
		throw new OutboundPolicyError(
			"Outbound target must resolve to a public address",
		);
	}
	const address = ipaddr.process(hostname);
	if (matchesAny(address, neverAllowed)) {
		throw new OutboundPolicyError(
			"Outbound target must resolve to a public address",
		);
	}
	return address;
}

export function assertPublicAddress(
	value: string,
	allowedPrivateCIDRs: readonly Network[] = [],
): void {
	const address = assertNotForbidden(value);
	if (address.range() === "unicast") return;
	if (matchesAny(address, allowedPrivateCIDRs)) return;
	throw new OutboundPolicyError(
		"Outbound target must resolve to a public address",
	);
}

async function resolveFamily(
	resolver: (hostname: string) => Promise<string[]>,
	hostname: string,
): Promise<string[]> {
	try {
		return await resolver(hostname);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENODATA" || code === "ENOTFOUND") return [];
		throw error;
	}
}

export async function resolvePinnedTarget(
	hostname: string,
	resolver: Resolver = { resolve4, resolve6 },
	allowedPrivateCIDRs: readonly Network[] = [],
): Promise<{ address: string; family: 4 | 6 }> {
	const literal = normalizedHostname(hostname);
	if (ipaddr.isValid(literal)) {
		assertPublicAddress(literal, allowedPrivateCIDRs);
		return {
			address: literal,
			family: ipaddr.parse(literal).kind() === "ipv4" ? 4 : 6,
		};
	}

	const [ipv4, ipv6] = await Promise.all([
		resolveFamily(resolver.resolve4, hostname),
		resolveFamily(resolver.resolve6, hostname),
	]);
	const answers = [
		...ipv4.map((address) => ({ address, family: 4 as const })),
		...ipv6.map((address) => ({ address, family: 6 as const })),
	];
	// Deliberately a plain Error, not an OutboundPolicyError: nothing was
	// refused, the resolver had no answer. A DNS outage is transient and must
	// stay retryable, unlike the policy refusals above.
	if (answers.length === 0) throw new Error("Outbound target did not resolve");
	for (const answer of answers) {
		assertPublicAddress(answer.address, allowedPrivateCIDRs);
	}
	return answers[0];
}

function responseHeaders(
	values: Record<string, string | string[] | undefined>,
): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(values)) {
		if (Array.isArray(value)) {
			for (const entry of value) headers.append(name, entry);
		} else if (value !== undefined) {
			headers.set(name, value);
		}
	}
	return headers;
}

export async function safeFetch(
	input: string | URL,
	options: SafeFetchOptions = {},
): Promise<Response> {
	// A malformed URL is a refusal, not a transport failure: it never becomes
	// valid, so retrying it burns the whole ladder. Unreachable from ntfy (whose
	// URL is schema-validated) but every M3b adapter takes a user-pasted webhook.
	let url: URL;
	try {
		url = new URL(input);
	} catch {
		throw new OutboundPolicyError("Outbound URL is not a valid absolute URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new OutboundPolicyError(
			"Outbound URL protocol must be HTTP or HTTPS",
		);
	}
	if (url.username || url.password) {
		throw new OutboundPolicyError("Outbound URL credentials are not allowed");
	}
	const target = await resolvePinnedTarget(
		url.hostname,
		undefined,
		options.allowedPrivateCIDRs,
	);
	const connect = buildConnector({ timeout: 10_000 });
	const dispatcher = new Agent({
		connect: (connectOptions, callback) =>
			connect(
				{
					...connectOptions,
					hostname: target.address,
					host: target.address,
					servername: normalizedHostname(url.hostname),
				},
				callback,
			),
	});

	try {
		const result = await request(url, {
			dispatcher,
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			signal: options.signal,
			headersTimeout: 10_000,
			bodyTimeout: 15_000,
		});
		const limit = options.maxResponseBytes ?? 1_048_576;
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of result.body) {
			const buffer = Buffer.from(chunk);
			size += buffer.length;
			if (size > limit) {
				throw new OutboundPolicyError(
					"Outbound response exceeds the configured size limit",
				);
			}
			chunks.push(buffer);
		}
		return new Response(Buffer.concat(chunks), {
			status: result.statusCode,
			statusText: result.statusText,
			headers: responseHeaders(result.headers),
		});
	} finally {
		// Bun ships its own `undici` shim whose Agent is a bare EventEmitter with
		// no close(), so an unguarded call threw out of this finally and turned
		// EVERY outbound send into a transport failure under the runtime the app
		// actually runs on -- invisible until a test exercised safeFetch for real
		// rather than injecting a double.
		//
		// NOTE: that same shim also ignores the pinning connector above, so under
		// Bun the resolved-address pin (DNS-rebinding protection) is inert. The
		// policy checks in resolvePinnedTarget still run before the request, so
		// the address boundary itself holds; closing the rebind window needs a
		// transport that honors a custom connector and is tracked separately.
		await dispatcher.close?.();
	}
}
