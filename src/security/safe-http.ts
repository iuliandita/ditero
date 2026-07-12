import { resolve4, resolve6 } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector, request } from "undici";

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
};

const transitionNetworks = [
	[ipaddr.parse("64:ff9b::"), 96],
	[ipaddr.parse("64:ff9b:1::"), 48],
	[ipaddr.parse("2001::"), 32],
	[ipaddr.parse("2002::"), 16],
] as const;

function normalizedHostname(value: string): string {
	return value.startsWith("[") && value.endsWith("]")
		? value.slice(1, -1)
		: value;
}

export function assertPublicAddress(value: string): void {
	const parsed = ipaddr.parse(normalizedHostname(value));
	if (parsed.kind() === "ipv6") {
		const address = parsed as ipaddr.IPv6;
		if (
			transitionNetworks.some(
				([network, prefix]) =>
					network.kind() === "ipv6" && address.match(network, prefix),
			)
		) {
			throw new Error("Outbound target must resolve to a public address");
		}
	}
	const address = ipaddr.process(normalizedHostname(value));
	if (address.range() !== "unicast") {
		throw new Error("Outbound target must resolve to a public address");
	}
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
): Promise<{ address: string; family: 4 | 6 }> {
	const literal = normalizedHostname(hostname);
	if (ipaddr.isValid(literal)) {
		assertPublicAddress(literal);
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
	if (answers.length === 0) throw new Error("Outbound target did not resolve");
	for (const answer of answers) assertPublicAddress(answer.address);
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
	const url = new URL(input);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Outbound URL protocol must be HTTP or HTTPS");
	}
	if (url.username || url.password) {
		throw new Error("Outbound URL credentials are not allowed");
	}
	const target = await resolvePinnedTarget(url.hostname);
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
				throw new Error("Outbound response exceeds the configured size limit");
			}
			chunks.push(buffer);
		}
		return new Response(Buffer.concat(chunks), {
			status: result.statusCode,
			statusText: result.statusText,
			headers: responseHeaders(result.headers),
		});
	} finally {
		await dispatcher.close();
	}
}
