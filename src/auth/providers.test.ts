import { describe, expect, it } from "vitest";
import { socialProvidersFromEnv } from "./providers.ts";

describe("socialProvidersFromEnv", () => {
	it("omits Google unless both credentials exist", () => {
		expect(socialProvidersFromEnv({})).toEqual({});
		expect(socialProvidersFromEnv({ GOOGLE_CLIENT_ID: "id" })).toEqual({});
		expect(socialProvidersFromEnv({ GOOGLE_CLIENT_SECRET: "secret" })).toEqual(
			{},
		);
	});

	it("configures Google when both credentials exist", () => {
		expect(
			socialProvidersFromEnv({
				GOOGLE_CLIENT_ID: "id",
				GOOGLE_CLIENT_SECRET: "secret",
			}),
		).toEqual({ google: { clientId: "id", clientSecret: "secret" } });
	});
});
