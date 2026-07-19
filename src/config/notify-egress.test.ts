import { describe, expect, it } from "vitest";
import { notifyAllowedPrivateCIDRs } from "./notify-egress.ts";

describe("notifyAllowedPrivateCIDRs", () => {
	it("defaults to an empty allowlist", () => {
		expect(notifyAllowedPrivateCIDRs()).toEqual([]);
		expect(notifyAllowedPrivateCIDRs("")).toEqual([]);
	});

	it("parses a comma-separated list of CIDRs", () => {
		expect(
			notifyAllowedPrivateCIDRs("10.10.10.0/24, 172.16.0.0/12"),
		).toHaveLength(2);
	});

	it("rejects a catch-all CIDR at boot", () => {
		expect(() => notifyAllowedPrivateCIDRs("0.0.0.0/0")).toThrow(
			/disables the private-address boundary/,
		);
	});

	it("rejects an IPv6 catch-all CIDR at boot", () => {
		expect(() => notifyAllowedPrivateCIDRs("::/0")).toThrow(
			/disables the private-address boundary/,
		);
	});

	it("rejects an unparseable CIDR loudly instead of skipping it", () => {
		expect(() => notifyAllowedPrivateCIDRs("not-a-cidr")).toThrow();
	});
});
