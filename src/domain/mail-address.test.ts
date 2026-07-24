import { describe, expect, it } from "vitest";
import { ADDRESS_MAX, mailableAddress } from "./mail-address.ts";

describe("mailableAddress", () => {
	it("accepts ordinary addresses", () => {
		for (const good of [
			"someone@example.test",
			"a.b+c@sub.example.test",
			"a+b.c@sub.example.test",
			"kid.1234@managed.invalid",
			`${"a".repeat(ADDRESS_MAX - "@b.test".length)}@b.test`,
		]) {
			expect(mailableAddress(good), good).toBe(good);
		}
	});

	it("rejects every shape that could redirect an envelope", () => {
		for (const bad of [
			"a@b.test\r\nBcc: victim@example.test",
			"a@b.test\nvictim@example.test",
			// A control character in the LOCAL part: one "@", a well-formed domain,
			// so the address-shape checks pass it and only the control guard does not.
			"inv\r\nitee@example.test",
			"inv\ritee@example.test",
			"inv itee@example.test",
			"a@b.test, victim@example.test",
			"a@b.test; victim@example.test",
			"Someone <victim@example.test>",
			"Victim <victim@example.test>",
			"undisclosed:;",
			"a@b.test ",
		]) {
			expect(mailableAddress(bad), bad).toBeNull();
		}
	});

	it("rejects malformed shapes and over-long values", () => {
		for (const bad of [
			"",
			"@example.test",
			"someone@",
			"a@b@c.test",
			"a@b@example.test",
			// No dotted domain: nothing routable leaves the host it was typed on.
			"a@localhost",
			"a@b",
			"a@example.test.",
			"a@b..c",
			"a@-bad-.test",
			"a@_dkim.test",
			"a@ünicode.test",
			`${"a".repeat(ADDRESS_MAX - "@b.test".length + 1)}@b.test`,
			`${"a".repeat(320)}@example.test`,
		]) {
			expect(mailableAddress(bad), bad).toBeNull();
		}
	});
});
