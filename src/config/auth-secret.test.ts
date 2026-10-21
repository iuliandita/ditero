import { expect, test } from "vitest";
import { validateAuthSecret } from "./auth-secret.ts";

test("production requires at least 32 auth-secret characters without logging the value", () => {
	for (const secret of [undefined, "", "x".repeat(31)]) {
		expect(() =>
			validateAuthSecret({
				NODE_ENV: "production",
				BETTER_AUTH_SECRET: secret,
			}),
		).toThrow(
			"BETTER_AUTH_SECRET must contain at least 32 characters in production",
		);
	}
	expect(() =>
		validateAuthSecret({
			NODE_ENV: "production",
			BETTER_AUTH_SECRET: "x".repeat(32),
		}),
	).not.toThrow();
	expect(() =>
		validateAuthSecret({
			NODE_ENV: "development",
			BETTER_AUTH_SECRET: "short",
		}),
	).not.toThrow();
});
