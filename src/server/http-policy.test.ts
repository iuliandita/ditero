import { describe, expect, test } from "vitest";
import { corsPolicy, securityHeaders } from "./http-policy.ts";

describe("corsPolicy", () => {
	test("disables cross-origin access in production", () => {
		expect(corsPolicy({ NODE_ENV: "production" })).toEqual({
			origin: false,
			methods: false,
			credentials: false,
			preflight: false,
		});
	});

	test("allows only configured development origins", () => {
		expect(
			corsPolicy({
				NODE_ENV: "development",
				TRUSTED_ORIGINS: " http://localhost:5173,https://dev.test ",
			}),
		).toMatchObject({
			origin: ["http://localhost:5173", "https://dev.test"],
			methods: ["GET", "POST"],
			allowedHeaders: ["Content-Type", "Authorization"],
			credentials: true,
			preflight: true,
		});
	});
});

describe("securityHeaders", () => {
	test("emits the production browser policy", () => {
		const headers = securityHeaders({
			NODE_ENV: "production",
			PUBLIC_ZERO_URL: "https://sync.example.test",
		});
		expect(headers).toMatchObject({
			"strict-transport-security": "max-age=31536000; includeSubDomains",
			"x-content-type-options": "nosniff",
			"x-frame-options": "DENY",
			"referrer-policy": "strict-origin-when-cross-origin",
			"permissions-policy": "camera=(), microphone=(), geolocation=()",
		});
		expect(headers["content-security-policy"]).toContain(
			"connect-src 'self' https://sync.example.test wss://sync.example.test",
		);
	});

	test("does not force production policy in development", () => {
		expect(securityHeaders({ NODE_ENV: "development" })).toEqual({});
	});
});
