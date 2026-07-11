import { afterAll, beforeAll, describe, expect, test } from "vitest";

let app: typeof import("./index.ts").app;
let pool: typeof import("../db/client.ts").pool;

beforeAll(async () => {
	process.env.BETTER_AUTH_URL = "http://localhost:3000";
	process.env.BETTER_AUTH_SECRET = "unit-test-better-auth-secret";
	process.env.DITERO_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
	({ app } = await import("./index.ts"));
	({ pool } = await import("../db/client.ts"));
});

afterAll(async () => {
	await pool.end();
});

describe("Zero endpoint authentication", () => {
	test.each([
		"query",
		"mutate",
	])("rejects unauthenticated %s requests with 401", async (endpoint) => {
		const response = await app.handle(
			new Request(`http://localhost/api/zero/${endpoint}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(response.status).toBe(401);
	});
});
