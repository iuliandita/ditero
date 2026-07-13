import { describe, expect, test } from "vitest";
import {
	assertRegistrationAllowed,
	resolveRegistrationMode,
} from "./registration.ts";

describe("resolveRegistrationMode", () => {
	test("defaults production to bootstrap", () => {
		expect(resolveRegistrationMode({ NODE_ENV: "production" })).toBe(
			"bootstrap",
		);
	});

	test("defaults non-production to open", () => {
		expect(resolveRegistrationMode({ NODE_ENV: "development" })).toBe("open");
		expect(resolveRegistrationMode({ NODE_ENV: "test" })).toBe("open");
	});

	test.each([
		"open",
		"bootstrap",
		"closed",
	] as const)("accepts explicit %s mode", (mode) => {
		expect(resolveRegistrationMode({ DITERO_REGISTRATION_MODE: mode })).toBe(
			mode,
		);
	});

	test("rejects invalid modes", () => {
		expect(() =>
			resolveRegistrationMode({ DITERO_REGISTRATION_MODE: "public" }),
		).toThrow(/invalid registration mode/i);
	});
});

describe("assertRegistrationAllowed", () => {
	test("open permits registration", () => {
		expect(() => assertRegistrationAllowed("open", 10)).not.toThrow();
	});

	test("closed rejects registration", () => {
		expect(() => assertRegistrationAllowed("closed", 0)).toThrow(
			/registration is disabled/i,
		);
	});

	test("bootstrap permits only the first registration", () => {
		expect(() => assertRegistrationAllowed("bootstrap", 0)).not.toThrow();
		expect(() => assertRegistrationAllowed("bootstrap", 1)).toThrow(
			/invitation/i,
		);
	});

	test("invited bypasses closed", () => {
		expect(() =>
			assertRegistrationAllowed("closed", 5, { invited: true }),
		).not.toThrow();
	});

	test("uninvited stays denied when closed", () => {
		expect(() =>
			assertRegistrationAllowed("closed", 5, { invited: false }),
		).toThrow(/registration is disabled/i);
	});

	test("invited bypasses bootstrap after the first user", () => {
		expect(() =>
			assertRegistrationAllowed("bootstrap", 3, { invited: true }),
		).not.toThrow();
	});

	test("uninvited stays denied for bootstrap after the first user", () => {
		expect(() =>
			assertRegistrationAllowed("bootstrap", 3, { invited: false }),
		).toThrow(/invitation/i);
	});

	test("open always permits regardless of invited", () => {
		expect(() =>
			assertRegistrationAllowed("open", 99, { invited: false }),
		).not.toThrow();
		expect(() =>
			assertRegistrationAllowed("open", 99, { invited: true }),
		).not.toThrow();
	});

	test("invited does not narrow the bootstrap first-user rule", () => {
		expect(() =>
			assertRegistrationAllowed("bootstrap", 0, { invited: false }),
		).not.toThrow();
	});
});
