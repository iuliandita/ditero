import { describe, expect, test } from "vitest";
import {
	registrationBypassActive,
	withRegistrationBypass,
} from "./registration-bypass.ts";

describe("registrationBypassActive", () => {
	test("false when no store is active", () => {
		expect(registrationBypassActive()).toBe(false);
	});

	test("true inside withRegistrationBypass", async () => {
		const inside = await withRegistrationBypass(async () =>
			registrationBypassActive(),
		);
		expect(inside).toBe(true);
	});

	test("false again after the bypass scope ends", async () => {
		await withRegistrationBypass(async () => undefined);
		expect(registrationBypassActive()).toBe(false);
	});

	test("returns the wrapped function result", async () => {
		expect(await withRegistrationBypass(async () => 42)).toBe(42);
	});
});
