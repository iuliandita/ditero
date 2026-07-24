import { EventEmitter } from "node:events";
import { describe, expect, it, test } from "vitest";
import { parseTrustedProxyCIDRs } from "../server/client-ip.ts";
import {
	assertPublicAddress,
	OutboundPolicyError,
	resolvePinnedTarget,
	safeFetch,
} from "./safe-http.ts";

// A stand-in for node's http/https `request`: it never opens a socket, it
// records the options it was handed and drives the response callback to
// completion so safeFetch's promise settles. The point is to observe how the
// connection would have been dialed (the `lookup` pin and the TLS `servername`)
// without a network.
type FakeRequestFn = NonNullable<
	NonNullable<Parameters<typeof safeFetch>[2]>["requestFn"]
>;

function fakeTransport(response: { status?: number; body?: string } = {}) {
	const calls: { url: URL; options: Record<string, unknown> }[] = [];
	const requestFn = ((
		url: URL,
		options: Record<string, unknown>,
		cb: (res: EventEmitter & { statusCode: number }) => void,
	) => {
		calls.push({ url, options });
		let destroyed = false;
		const res = Object.assign(new EventEmitter(), {
			statusCode: response.status ?? 200,
			statusMessage: "OK",
			headers: {} as Record<string, string>,
			setTimeout: () => {},
		});
		const req = Object.assign(new EventEmitter(), {
			write: () => true,
			// Stage the response so a `destroy` triggered mid-stream (the byte cap)
			// stops the "end" from firing, exactly as a real socket would.
			end: () => {
				queueMicrotask(() => {
					cb(res);
					queueMicrotask(() => {
						if (destroyed) return;
						res.emit("data", Buffer.from(response.body ?? ""));
						queueMicrotask(() => {
							if (destroyed) return;
							res.emit("end");
						});
					});
				});
			},
			destroy: (error?: Error) => {
				destroyed = true;
				queueMicrotask(() => req.emit("error", error));
			},
		});
		return req;
	}) as unknown as FakeRequestFn;
	return { calls, requestFn };
}

const publicResolver = {
	resolve4: async () => ["93.184.216.34"],
	resolve6: async () => [],
};

// The invariant #31 is about: the socket must dial the address the policy check
// already vetted, so a DNS server that answers public-for-the-check then
// private-for-the-connect cannot rebind between the two. Under Bun's undici
// shim the connector pin was silently ignored; the node http/https path pins
// through a custom `lookup`.
describe("outbound connection pinning", () => {
	async function drainLookup(
		lookup: unknown,
	): Promise<Array<{ address: string; family: number }>> {
		return await new Promise((resolve) => {
			(lookup as (h: string, o: unknown, cb: unknown) => void)(
				"hooks.example.test",
				{ all: true },
				(_err: unknown, result: Array<{ address: string; family: number }>) =>
					resolve(result),
			);
		});
	}

	it("dials the vetted address, not a fresh resolution", async () => {
		const { calls, requestFn } = fakeTransport();
		await safeFetch(
			"https://hooks.example.test/webhook",
			{},
			{ resolver: publicResolver, requestFn },
		);
		expect(calls).toHaveLength(1);
		expect(await drainLookup(calls[0].options.lookup)).toEqual([
			{ address: "93.184.216.34", family: 4 },
		]);
	});

	it("keeps the original hostname for TLS so the certificate is validated against it", async () => {
		const { calls, requestFn } = fakeTransport();
		await safeFetch(
			"https://hooks.example.test/webhook",
			{},
			{ resolver: publicResolver, requestFn },
		);
		expect(calls[0].options.servername).toBe("hooks.example.test");
	});

	it("returns the transport's response as a Response", async () => {
		const { requestFn } = fakeTransport({ status: 202, body: "pong" });
		const response = await safeFetch(
			"https://hooks.example.test/webhook",
			{},
			{ resolver: publicResolver, requestFn },
		);
		expect(response.status).toBe(202);
		expect(await response.text()).toBe("pong");
	});

	it("refuses a rebinding resolver before any socket is opened", async () => {
		const { calls, requestFn } = fakeTransport();
		await expect(
			safeFetch(
				"https://hooks.example.test/webhook",
				{},
				{
					resolver: {
						resolve4: async () => ["93.184.216.34", "127.0.0.1"],
						resolve6: async () => [],
					},
					requestFn,
				},
			),
		).rejects.toThrow(/public/i);
		expect(calls).toHaveLength(0);
	});

	it("caps the response body and reports the overflow as a policy refusal", async () => {
		const { requestFn } = fakeTransport({ body: "x".repeat(100) });
		await expect(
			safeFetch(
				"https://hooks.example.test/webhook",
				{ maxResponseBytes: 10 },
				{ resolver: publicResolver, requestFn },
			),
		).rejects.toBeInstanceOf(OutboundPolicyError);
	});
});

describe("outbound HTTP target validation", () => {
	test.each([
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"::1",
		"fe80::1",
		"::ffff:127.0.0.1",
		"64:ff9b::7f00:1",
		"64:ff9b:1::7f00:1",
		"2002:7f00:1::",
		"2001:0000:4136:e378:8000:63bf:3fff:fdd2",
		// RFC 4291 IPv4-compatible: the same targets ::ffff: forms already cover,
		// spelled so that range() reports plain unicast.
		"::a9fe:a9fe",
		"::7f00:1",
	])("rejects non-public or transition address %s", (address) => {
		expect(() => assertPublicAddress(address)).toThrow();
	});

	// The ::/96 entry must not change how the two addresses inside it that were
	// already blocked by neverAllowed are classified.
	test.each(["::", "::1"])("still rejects %s", (address) => {
		expect(() => assertPublicAddress(address)).toThrow(OutboundPolicyError);
	});

	test.each([
		"93.184.216.34",
		"2001:4860:4860::8888",
	])("accepts public unicast address %s", (address) => {
		expect(() => assertPublicAddress(address)).not.toThrow();
	});

	test("rejects a hostname when any DNS answer is private", async () => {
		await expect(
			resolvePinnedTarget("hooks.example.test", {
				resolve4: async () => ["93.184.216.34", "127.0.0.1"],
				resolve6: async () => [],
			}),
		).rejects.toThrow(/public/i);
	});

	test("returns one validated address for a single pinned connection", async () => {
		await expect(
			resolvePinnedTarget("hooks.example.test", {
				resolve4: async () => ["93.184.216.34"],
				resolve6: async () => ["2001:4860:4860::8888"],
			}),
		).resolves.toEqual({ address: "93.184.216.34", family: 4 });
	});

	test("rejects literal local targets before opening a socket", async () => {
		await expect(safeFetch("http://127.0.0.1/admin")).rejects.toThrow(
			/public/i,
		);
	});

	test("rejects credentials and non-HTTP protocols", async () => {
		await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/protocol/i);
		await expect(safeFetch("https://user:pass@example.com")).rejects.toThrow(
			/credentials/i,
		);
	});

	// Every refusal must be an OutboundPolicyError, not a bare Error: callers
	// classify on the type to decide permanent vs retryable, and a refusal
	// retried on the ladder re-probes the target once per attempt.
	test.each([
		["a blocked address", "http://127.0.0.1/admin"],
		["a non-HTTP protocol", "file:///etc/passwd"],
		["URL credentials", "https://user:pass@example.com"],
		["a malformed URL", "not-a-url"],
		["an empty URL", ""],
	])("refuses %s as a policy error", async (_case, input) => {
		await expect(safeFetch(input)).rejects.toBeInstanceOf(OutboundPolicyError);
	});

	// A resolver that returns nothing is NOT a policy refusal: NXDOMAIN and a
	// resolver outage are indistinguishable here, so it stays retryable.
	test("leaves an unresolvable target a plain Error", async () => {
		const error = await resolvePinnedTarget("nowhere.invalid", {
			resolve4: async () => [],
			resolve6: async () => [],
		}).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(OutboundPolicyError);
	});
});

describe("assertPublicAddress with an allowlist", () => {
	const allow = parseTrustedProxyCIDRs(["10.10.10.0/24"]);

	it("rejects a private address with no allowlist", () => {
		expect(() => assertPublicAddress("10.10.10.20")).toThrow();
	});

	it("permits an allowlisted private address", () => {
		expect(() => assertPublicAddress("10.10.10.20", allow)).not.toThrow();
	});

	it("rejects a private address outside the allowlist", () => {
		expect(() => assertPublicAddress("192.168.1.5", allow)).toThrow();
	});

	it("rejects loopback even when the allowlist would cover it", () => {
		const loopback = parseTrustedProxyCIDRs(["127.0.0.0/8"]);
		expect(() => assertPublicAddress("127.0.0.1", loopback)).toThrow();
	});

	it("rejects cloud metadata even when allowlisted", () => {
		const metadata = parseTrustedProxyCIDRs(["169.254.0.0/16"]);
		expect(() => assertPublicAddress("169.254.169.254", metadata)).toThrow();
	});

	it("rejects CGNAT even when allowlisted", () => {
		const cgnat = parseTrustedProxyCIDRs(["100.64.0.0/10"]);
		expect(() => assertPublicAddress("100.64.0.1", cgnat)).toThrow();
	});

	it("rejects NAT64 even when allowlisted", () => {
		const nat64 = parseTrustedProxyCIDRs(["64:ff9b::/96"]);
		expect(() => assertPublicAddress("64:ff9b::7f00:1", nat64)).toThrow();
	});

	it("still permits ordinary public addresses", () => {
		expect(() => assertPublicAddress("93.184.216.34", allow)).not.toThrow();
	});

	it("rejects a mapped IPv4-in-IPv6 loopback even when allowlisted", () => {
		const loopback = parseTrustedProxyCIDRs(["127.0.0.0/8"]);
		expect(() => assertPublicAddress("::ffff:127.0.0.1", loopback)).toThrow();
		expect(() => assertPublicAddress("::ffff:7f00:1", loopback)).toThrow();
	});

	it("rejects multicast and broadcast even when allowlisted", () => {
		const wide = parseTrustedProxyCIDRs(["224.0.0.0/4", "255.255.255.255/32"]);
		expect(() => assertPublicAddress("224.0.0.1", wide)).toThrow();
		expect(() => assertPublicAddress("255.255.255.255", wide)).toThrow();
	});

	it("permits an allowlisted IPv6 unique-local address", () => {
		const ula = parseTrustedProxyCIDRs(["fd00::/8"]);
		expect(() => assertPublicAddress("fd00::1", ula)).not.toThrow();
	});

	it("rejects a hostname resolving to both an allowlisted and a non-allowlisted private address", async () => {
		await expect(
			resolvePinnedTarget(
				"hooks.example.test",
				{
					resolve4: async () => ["10.10.10.20", "192.168.1.5"],
					resolve6: async () => [],
				},
				allow,
			),
		).rejects.toThrow(/public/i);
	});
});
