import { describe, expect, test } from "vitest";
import {
	assertPublicAddress,
	resolvePinnedTarget,
	safeFetch,
} from "./safe-http.ts";

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
	])("rejects non-public or transition address %s", (address) => {
		expect(() => assertPublicAddress(address)).toThrow();
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
});
