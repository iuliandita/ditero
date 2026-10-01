// Covers request gating that completes before any database access; grant and
// session persistence are verified against a real database by the integration
// suite, not here.
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { nativeAuthRoutes } from "./routes.ts";

const ID = Buffer.alloc(32, 7).toString("base64url");

function app(rateLimit = async () => true) {
	const pool = {
		query: vi.fn(),
		connect: vi.fn(),
	} as unknown as Pool;
	const guardedPost = vi.fn(() => async () => new Response("Forbidden"));
	const routes = nativeAuthRoutes({
		pool,
		sessions: { createSession: vi.fn(), deleteSession: vi.fn() },
		guards: { guardedPost: guardedPost as never },
		rateLimit,
	});
	return { routes, pool };
}

function post(
	path: string,
	body: string,
	headers: Record<string, string> = {},
) {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

describe("native auth routes", () => {
	it.each([
		["/api/native/grants", { challenge: ID, deviceLabel: "Phone" }],
		["/api/native/grants/exchange", { grantId: ID, verifier: "a".repeat(43) }],
	])("%s refuses ambient credentials before any work", async (path, body) => {
		for (const header of ["origin", "cookie", "authorization"]) {
			const { routes, pool } = app();
			const response = await routes.handle(
				post(path, JSON.stringify(body), { [header]: "x" }),
			);
			expect(response.status).toBe(400);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(pool.query).not.toHaveBeenCalled();
			expect(pool.connect).not.toHaveBeenCalled();
		}
	});

	it("rejects unexpected keys and oversized bodies with no-store", async () => {
		const { routes, pool } = app();
		const extra = await routes.handle(
			post(
				"/api/native/grants/exchange",
				JSON.stringify({ grantId: ID, verifier: "a".repeat(43), userId: "u" }),
			),
		);
		expect(extra.status).toBe(400);
		const big = await routes.handle(
			post("/api/native/grants", JSON.stringify({ pad: "x".repeat(5000) })),
		);
		expect(big.status).toBe(413);
		expect(big.headers.get("cache-control")).toBe("no-store");
		expect(pool.query).not.toHaveBeenCalled();
	});

	it("answers 429 when the shared limiter refuses", async () => {
		const { routes } = app(async () => false);
		const response = await routes.handle(
			new Request("http://localhost/api/native/session", {
				headers: { authorization: "Bearer abc" },
			}),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("5");
	});

	it("never authenticates the session lookup without a lone Bearer header", async () => {
		const cases: Array<Record<string, string>> = [
			{},
			{ cookie: "better-auth.session_token=x" },
			{ authorization: "Bearer abc", cookie: "x" },
			{ authorization: "Bearer abc", origin: "http://localhost" },
		];
		for (const headers of cases) {
			const { routes, pool } = app();
			const response = await routes.handle(
				new Request("http://localhost/api/native/session", { headers }),
			);
			expect([400, 401]).toContain(response.status);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(pool.query).not.toHaveBeenCalled();
		}
	});

	it("marks guard rejections on approve as no-store", async () => {
		const { routes } = app();
		const response = await routes.handle(
			post("/api/native/grants/approve", JSON.stringify({ grantId: ID })),
		);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});
