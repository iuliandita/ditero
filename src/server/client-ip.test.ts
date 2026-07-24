import { describe, expect, test } from "vitest";
import {
	parseTrustedProxyCIDRs,
	resolveClientIP,
	resolveClientRateKey,
	sanitizeAuthRequest,
	UNKNOWN_CLIENT_IP,
} from "./client-ip.ts";

describe("resolveClientIP", () => {
	const trustedProxies = parseTrustedProxyCIDRs([
		"10.0.0.0/8",
		"2001:db8::/32",
	]);

	test("ignores forwarding headers from an untrusted direct peer", () => {
		expect(
			resolveClientIP({
				peerAddress: "203.0.113.8",
				forwardedFor: "198.51.100.20",
				trustedProxies,
			}),
		).toBe("203.0.113.8");
	});

	test("walks a trusted proxy chain from right to left", () => {
		expect(
			resolveClientIP({
				peerAddress: "10.0.0.2",
				forwardedFor: "198.51.100.20, 10.0.0.3",
				trustedProxies,
			}),
		).toBe("198.51.100.20");
	});

	test("normalizes IPv4-mapped IPv6 peers before CIDR matching", () => {
		expect(
			resolveClientIP({
				peerAddress: "::ffff:10.0.0.2",
				forwardedFor: "198.51.100.20",
				trustedProxies,
			}),
		).toBe("198.51.100.20");
	});

	test("fails closed on a malformed forwarded chain", () => {
		expect(
			resolveClientIP({
				peerAddress: "10.0.0.2",
				forwardedFor: "not-an-ip, 10.0.0.3",
				trustedProxies,
			}),
		).toBe("10.0.0.2");
	});

	test("rejects invalid trusted proxy ranges", () => {
		expect(() => parseTrustedProxyCIDRs(["10.0.0.0/99"])).toThrow();
	});

	test("replaces client-supplied identity headers with the direct peer", () => {
		const request = sanitizeAuthRequest(
			new Request("https://tasks.test/api/auth/sign-in/email", {
				headers: {
					"x-forwarded-for": "198.51.100.20",
					"x-ditero-client-ip": "198.51.100.21",
				},
			}),
			"203.0.113.8",
			trustedProxies,
		);

		expect(request.headers.get("x-forwarded-for")).toBeNull();
		expect(request.headers.get("x-ditero-client-ip")).toBe("203.0.113.8");
	});
});

describe("resolveClientRateKey", () => {
	// 127.0.0.1 trusted models the common "behind a local reverse proxy" deploy.
	const trustedProxies = parseTrustedProxyCIDRs(["127.0.0.1/32"]);

	test("collapses a missing peer to the shared unknown key", () => {
		expect(
			resolveClientRateKey({
				peerAddress: null,
				forwardedFor: null,
				trustedProxies,
			}),
		).toBe(UNKNOWN_CLIENT_IP);
	});

	// The regression: a null peer must not be synthesized into a trusted
	// 127.0.0.1 that then honours an attacker-chosen X-Forwarded-For, which would
	// hand the caller a freely-rotatable rate-limit key. Guards client-ip.ts
	// resolveClientRateKey's null branch.
	test("ignores forwarding headers when the peer is missing", () => {
		expect(
			resolveClientRateKey({
				peerAddress: undefined,
				forwardedFor: "203.0.113.9",
				trustedProxies,
			}),
		).toBe(UNKNOWN_CLIENT_IP);
	});

	test("keys a real peer through the normal resolution path", () => {
		expect(
			resolveClientRateKey({
				peerAddress: "127.0.0.1",
				forwardedFor: "203.0.113.9",
				trustedProxies,
			}),
		).toBe("203.0.113.9");
	});
});
