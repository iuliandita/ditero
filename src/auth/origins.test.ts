import { describe, expect, test } from "vitest";
import { trustedAuthOrigins } from "./origins.ts";

describe("trustedAuthOrigins", () => {
	test("adds no development origin in production", () => {
		expect(trustedAuthOrigins({ NODE_ENV: "production" })).toEqual([]);
	});

	test("uses the local web origin outside production", () => {
		expect(trustedAuthOrigins({ NODE_ENV: "development" })).toEqual([
			"http://localhost:5173",
		]);
	});

	test("normalizes explicit additional origins", () => {
		expect(
			trustedAuthOrigins({
				NODE_ENV: "production",
				TRUSTED_ORIGINS: " https://one.test,https://two.test ",
			}),
		).toEqual(["https://one.test", "https://two.test"]);
	});
});
