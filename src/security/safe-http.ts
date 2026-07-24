import { resolve4, resolve6 } from "node:dns/promises";
import type { IncomingMessage, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import type { Network } from "../server/client-ip.ts";

// A node http/https `request`. safeFetch pins the socket through the `lookup`
// option, so the transport must be one that honors it -- which rules out Bun's
// undici shim, whose Agent ignores a custom connector (issue #31).
type RequestFn = (
	url: URL,
	options: RequestOptions,
	callback: (response: IncomingMessage) => void,
) => {
	on(event: "error", listener: (error: Error) => void): unknown;
	write(chunk: string | Uint8Array): unknown;
	end(): unknown;
	destroy(error?: Error): unknown;
};

// Injectable seams, defaulted for production. Tests supply a resolver to script
// DNS answers and a requestFn to observe how the socket would be dialed without
// opening one.
type SafeFetchDeps = {
	resolver?: Resolver;
	requestFn?: RequestFn;
};

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
	// Only long polling needs this: Telegram's getUpdates deliberately withholds
	// response headers for the whole poll window, so the default would abort
	// every poll before it could return an update.
	headersTimeoutMs?: number;
};

// Encodings that hide a private/loopback address inside an otherwise-unicast
// IPv6 literal. ipaddr.js only unwraps the ipv4-mapped/compatible forms (via
// `process`); these transition encodings keep their embedded IPv4 payload
// hidden from `range()`, so they must be rejected on the raw parsed address,
// before any allowlist check, and regardless of how the embedded address
// would otherwise be classified.
const transitionNetworks = [
	// RFC 4291 IPv4-compatible: `::a9fe:a9fe` is the metadata endpoint spelled so
	// that `range()` reports plain unicast. `::` and `::1` also fall inside it and
	// stay refused, as they already were via neverAllowed.
	[ipaddr.parse("::"), 96],
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
	deps: SafeFetchDeps = {},
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
		deps.resolver,
		options.allowedPrivateCIDRs,
	);
	const requestFn =
		deps.requestFn ?? (url.protocol === "https:" ? httpsRequest : httpRequest);
	return await pinnedRequest(url, target, options, requestFn);
}

// Pins the socket to the address resolvePinnedTarget already vetted: the custom
// `lookup` returns that one address and nothing else, so the transport never
// re-resolves the hostname and a DNS server cannot answer public for the policy
// check then private for the connect. `servername` keeps TLS pointed at the
// real hostname so the certificate is still validated against the name, not the
// pinned IP. This is the node path that replaces undici, whose connector Bun
// ignores.
async function pinnedRequest(
	url: URL,
	target: { address: string; family: 4 | 6 },
	options: SafeFetchOptions,
	requestFn: RequestFn,
): Promise<Response> {
	const headersTimeout = options.headersTimeoutMs ?? 10_000;
	// The body budget is on top of the headers wait, never below it.
	const bodyTimeout = Math.max(15_000, headersTimeout + 5_000);
	const limit = options.maxResponseBytes ?? 1_048_576;

	return await new Promise<Response>((resolve, reject) => {
		let settled = false;
		const settle = (run: () => void) => {
			if (settled) return;
			settled = true;
			run();
		};

		const requestOptions: RequestOptions = {
			method: options.method ?? "GET",
			headers: toOutgoingHeaders(options.headers),
			signal: options.signal,
			servername: normalizedHostname(url.hostname),
			lookup: (_hostname, lookupOptions, callback) => {
				const entry = { address: target.address, family: target.family };
				// Modern node and Bun both request the "all" form (an array); the
				// tuple form is the fallback for a runtime that asks for one address.
				if (
					typeof lookupOptions === "object" &&
					lookupOptions !== null &&
					(lookupOptions as { all?: boolean }).all
				) {
					(callback as (e: null, a: (typeof entry)[]) => void)(null, [entry]);
				} else {
					(callback as (e: null, a: string, f: number) => void)(
						null,
						target.address,
						target.family,
					);
				}
			},
		} as RequestOptions;

		const request = requestFn(url, requestOptions, (response) => {
			clearTimeout(headersTimer);
			// bodyTimeout bounds the gap between chunks: a server dripping one byte
			// at a time would otherwise hold the slot forever (C18).
			response.setTimeout?.(bodyTimeout, () => {
				request.destroy(new Error("Outbound response body stalled"));
			});
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				const buffer = Buffer.from(chunk);
				size += buffer.length;
				if (size > limit) {
					// A refusal, not a transport error: the response is already too big
					// and retrying re-probes the target and re-downloads the overflow.
					request.destroy(
						new OutboundPolicyError(
							"Outbound response exceeds the configured size limit",
						),
					);
					return;
				}
				chunks.push(buffer);
			});
			response.on("end", () =>
				settle(() =>
					resolve(
						new Response(Buffer.concat(chunks), {
							status: response.statusCode ?? 0,
							statusText: response.statusMessage ?? "",
							headers: responseHeaders(response.headers),
						}),
					),
				),
			);
			response.on("error", (error: Error) => settle(() => reject(error)));
		});

		// A plain Error, never an OutboundPolicyError: headers that never arrive are
		// a transport failure and must stay retryable, unlike the size-cap refusal.
		const headersTimer = setTimeout(() => {
			request.destroy(
				new Error("Outbound request timed out waiting for response headers"),
			);
		}, headersTimeout);

		request.on("error", (error) => {
			clearTimeout(headersTimer);
			settle(() => reject(error));
		});
		if (options.body !== undefined) request.write(options.body);
		request.end();
	});
}

// node's request wants a plain header bag, not a HeadersInit. Routing through
// Headers keeps the CR/LF rejection undici gave for free: a hostile header
// value throws here rather than smuggling a second header onto the wire.
function toOutgoingHeaders(
	init: HeadersInit | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {};
	new Headers(init).forEach((value, name) => {
		headers[name] = value;
	});
	return headers;
}
