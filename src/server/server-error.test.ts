import { Elysia, status } from "elysia";
import { expect, test, vi } from "vitest";
import { handleServerError } from "./server-error.ts";

test("conceals unhandled messages, logs correlation details and preserves explicit typed responses", async () => {
	const log = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		const error = new Error("database constraint private_detail");
		Object.assign(error, {
			cause: Object.assign(new Error("private database payload"), {
				code: "23505",
				query: "private SQL",
				params: ["private params"],
				detail: "private row",
			}),
		});
		const api = new Elysia().onError(handleServerError).use(
			new Elysia()
				.get("/fail", () => {
					throw error;
				})
				.get("/typed-throw", () => {
					throw status(409, { code: "typed-conflict" });
				})
				.get("/typed", () =>
					Response.json({ code: "import-busy" }, { status: 429 }),
				),
		);
		const response = await api.handle(new Request("http://localhost/fail"));
		expect(response.status).toBe(500);
		const body = await response.json();
		expect(body).toEqual({
			code: "internal-error",
			message: "An unexpected error occurred",
			correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		expect(response.headers.get("x-correlation-id")).toBe(body.correlationId);
		expect(log).toHaveBeenCalledWith("HTTP request failed", {
			errorClass: "Error",
			sqlState: "23505",
			correlationId: body.correlationId,
		});
		expect(JSON.stringify(log.mock.calls)).not.toMatch(
			/private|query|params|detail/,
		);
		const typed = await api.handle(new Request("http://localhost/typed"));
		const typedThrow = await api.handle(
			new Request("http://localhost/typed-throw"),
		);
		expect(typedThrow.status).toBe(409);
		expect(await typedThrow.json()).toEqual({ code: "typed-conflict" });
		expect(typed.status).toBe(429);
		expect(await typed.json()).toEqual({ code: "import-busy" });
		expect(
			(await api.handle(new Request("http://localhost/missing"))).status,
		).toBe(404);
	} finally {
		log.mockRestore();
	}
});
