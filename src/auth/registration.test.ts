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
});
