import { describe, expect, test } from "vitest";
import {
	parseTrustedProxyCIDRs,
	resolveClientIP,
	sanitizeAuthRequest,
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
