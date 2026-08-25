import { describe, expect, it } from "vitest";
import {
	DEFAULT_ZERO_URL,
	publicConfig,
	zeroPublicURL,
} from "./public-config.ts";

describe("zeroPublicURL", () => {
	it("defaults when unset", () => {
		expect(zeroPublicURL({})).toBe(DEFAULT_ZERO_URL);
	});

	it("defaults when empty, so a blank compose value is not dialled", () => {
		expect(zeroPublicURL({ PUBLIC_ZERO_URL: "" })).toBe(DEFAULT_ZERO_URL);
	});

	it("honours a deployment's own origin", () => {
		expect(
			zeroPublicURL({ PUBLIC_ZERO_URL: "https://sync.example.test" }),
		).toBe("https://sync.example.test");
	});
});

describe("publicConfig", () => {
	it("serves the zero URL the client dials", () => {
		expect(
			publicConfig({ PUBLIC_ZERO_URL: "https://sync.example.test" }),
		).toEqual({ zeroURL: "https://sync.example.test" });
	});

	it("carries nothing beyond the zero URL, so no secret can leak through it", () => {
		expect(Object.keys(publicConfig({ BETTER_AUTH_SECRET: "s" }))).toEqual([
			"zeroURL",
		]);
	});
});
