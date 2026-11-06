import { Elysia } from "elysia";
import { expect, test } from "vitest";
import { enforceRequestBodyLimit } from "./body-limit.ts";

const api = () =>
	new Elysia()
		.onRequest(enforceRequestBodyLimit)
		.use(
			new Elysia().post(
				"/*",
				async ({ request }) => new Response(await request.text()),
				{ parse: "none" },
			),
		);

test.each([
	"declared",
	"streamed",
])("rejects oversized %s auth and JSON bodies before dispatch", async (mode) => {
	for (const [path, limit] of [
		["/api/auth/sign-up/email", 64 * 1024],
		["/api/invite/create", 1024 * 1024],
		["/api/auth/sso/saml2/sp/acs/provider", 1024 * 1024],
	] as const) {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(limit + 1));
				controller.close();
			},
		});
		const response = await api().handle(
			new Request(`http://localhost${path}`, {
				method: "POST",
				body: stream,
				duplex: "half",
				headers:
					mode === "declared" ? { "content-length": String(limit + 1) } : {},
			} as RequestInit),
		);
		expect(response.status).toBe(413);
	}
});

test("keeps bounded auth bytes intact and delegates large import and upload bodies", async () => {
	for (const [path, body] of [
		["/api/auth/sign-up/email", '{"name":"Reader"}'],
		["/api/portability/import/plans", "x".repeat(1024 * 1024 + 1)],
		["/api/portability/import/plans/", "x".repeat(1024 * 1024 + 1)],
		["/api/attachments/file/upload", "x".repeat(1024 * 1024 + 1)],
	]) {
		const response = await api().handle(
			new Request(`http://localhost${path}`, { method: "POST", body }),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(body);
	}
});
