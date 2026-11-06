import { Elysia } from "elysia";
import { expect, test, vi } from "vitest";
import { enforceRequestBodyLimit, requestBodyLimit } from "./body-limit.ts";

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

test.each([
	"/api/zero/mutate",
	"/api/zero/push",
	"/api/notifications/slack/interactions",
	"/api/notifications/discord/interactions",
	"/api/notifications/telegram/webhook",
])("delegates %s without touching the body", async (path) => {
	const request = new Request(`http://localhost${path}`, {
		method: "POST",
		body: "bytes",
		headers: { "content-length": "8388608" },
	});
	const watched = new Proxy(request, {
		get(target, key) {
			if (key === "body" || key === "clone")
				throw new Error("body touched before route admission");
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	expect(requestBodyLimit(watched)).toBeNull();
	expect(await enforceRequestBodyLimit({ request: watched })).toBeUndefined();
});

test("uses an idle deadline and includes deployment headers on early refusals", async () => {
	vi.useFakeTimers();
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("PUBLIC_ZERO_URL", "https://sync.example.test");
	try {
		let stream!: ReadableStreamDefaultController<Uint8Array>;
		const request = new Request("http://localhost/api/auth/sign-up/email", {
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					stream = controller;
				},
			}),
			duplex: "half",
		} as RequestInit);
		const pending = enforceRequestBodyLimit({ request });
		let earlyResponse: Response | undefined;
		void pending.then((response) => {
			earlyResponse = response;
		});
		for (let chunk = 0; chunk < 3; chunk++) {
			await vi.advanceTimersByTimeAsync(4000);
			expect(earlyResponse).toBeUndefined();
			stream.enqueue(new TextEncoder().encode("a"));
			await vi.advanceTimersByTimeAsync(0);
		}
		stream.close();
		expect(await pending).toBeUndefined();
		const stalled = new Request("http://localhost/api/auth/sign-up/email", {
			method: "POST",
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array([1]));
				},
			}),
			duplex: "half",
		} as RequestInit);
		const timeout = enforceRequestBodyLimit({ request: stalled });
		await vi.advanceTimersByTimeAsync(5000);
		const timedOut = await timeout;
		expect(timedOut?.status).toBe(408);
		expect(timedOut?.headers.get("x-content-type-options")).toBe("nosniff");
		const refused = await enforceRequestBodyLimit({
			request: new Request("http://localhost/api/auth/sign-up/email", {
				method: "POST",
				headers: { "content-length": "9999999" },
			}),
		});
		expect(refused?.status).toBe(413);
		expect(refused?.headers.get("content-security-policy")).toContain(
			"default-src 'self'",
		);
		vi.stubEnv("NODE_ENV", "development");
		vi.stubEnv("TRUSTED_ORIGINS", "http://localhost:5173");
		const cors = await enforceRequestBodyLimit({
			request: new Request("http://localhost/api/auth/sign-up/email", {
				method: "POST",
				headers: {
					"content-length": "9999999",
					origin: "http://localhost:5173",
				},
			}),
		});
		expect(cors?.headers.get("access-control-allow-origin")).toBe(
			"http://localhost:5173",
		);
		expect(cors?.headers.get("access-control-allow-credentials")).toBe("true");
	} finally {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	}
});
