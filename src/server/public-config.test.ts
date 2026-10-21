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
		).toEqual({ zeroURL: "https://sync.example.test", socialProviders: [] });
	});

	it.each([
		[{}, []],
		[{ GOOGLE_CLIENT_ID: "id" }, []],
		[{ GOOGLE_CLIENT_SECRET: "secret" }, []],
		[{ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "" }, []],
		[{ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }, ["google"]],
	])("publishes only provider names for %j", (env, socialProviders) => {
		expect(publicConfig({ ...env, BETTER_AUTH_SECRET: "private" })).toEqual({
			zeroURL: DEFAULT_ZERO_URL,
			socialProviders,
		});
	});
});
