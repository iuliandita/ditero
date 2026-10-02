import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFieldKeyRing } from "../../security/field-encryption.ts";
import {
	authenticateNative,
	type NativeSession,
} from "../native-auth/session.ts";
import { nativePushRoutes } from "./routes.ts";
import { NativePushStore, PushAuthorityError } from "./store.ts";

vi.mock("../native-auth/session.ts", () => ({ authenticateNative: vi.fn() }));
const owner = { userId: "u", sessionId: "s", deviceId: "d" } as NativeSession;
const input = { notificationId: "n", registrationId: "r" };
function setup(allowed = true, encrypted = true) {
	vi.mocked(authenticateNative).mockResolvedValue(owner);
	const open = vi.spyOn(NativePushStore.prototype, "open");
	const routes = nativePushRoutes({
		pool: {} as Pool,
		ring: encrypted
			? createFieldKeyRing({
					current: Buffer.alloc(32, 7).toString("base64"),
				})
			: null,
		configuration: {},
		rateLimit: async () => allowed,
	});
	return { routes, open };
}
function request(
	body = JSON.stringify(input),
	headers: Record<string, string> = {},
) {
	return new Request("http://localhost/api/native/push/open", {
		method: "POST",
		headers: {
			authorization: "Bearer token",
			"content-type": "application/json",
			...headers,
		},
		body,
	});
}
async function checked(response: Response, status: number, body: unknown) {
	expect(response.status).toBe(status);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.has("set-cookie")).toBe(false);
	expect(await response.json()).toEqual(body);
}
afterEach(() => vi.restoreAllMocks());
describe("native push open route", () => {
	it("passes only capability IDs and native authority; works with providers disabled", async () => {
		const { routes, open } = setup();
		const target = {
			kind: "task" as const,
			taskId: "t",
			listId: "l",
			workspaceId: "w",
		};
		open.mockResolvedValue(target);
		await checked(await routes.handle(request()), 200, { target });
		expect(open).toHaveBeenCalledWith(owner, input);
	});
	it("opens stored notifications without an encryption ring", async () => {
		const { routes, open } = setup(true, false);
		const target = { kind: "workspace" as const, workspaceId: "w" };
		open.mockResolvedValue(target);
		await checked(await routes.handle(request()), 200, { target });
	});
	it("returns the same unavailable response for an unresolved notification", async () => {
		const { routes, open } = setup();
		open.mockResolvedValue(null);
		await checked(await routes.handle(request()), 404, {
			code: "notification-unavailable",
		});
	});
	it("maps authority revoked after admission to unauthorized", async () => {
		const { routes, open } = setup();
		open.mockRejectedValue(new PushAuthorityError());
		await checked(await routes.handle(request()), 401, {
			code: "unauthorized",
		});
	});
	it.each([
		"cookie",
		"origin",
	])("rejects %s before authentication or body access", async (header) => {
		const { routes, open } = setup();
		vi.mocked(authenticateNative).mockClear();
		await checked(await routes.handle(request("{", { [header]: "" })), 400, {
			code: "credentials-not-allowed",
		});
		expect(authenticateNative).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});
	it("authenticates before parsing an invalid body", async () => {
		const { routes, open } = setup();
		vi.mocked(authenticateNative).mockResolvedValue(null);
		await checked(await routes.handle(request("{")), 401, {
			code: "unauthorized",
		});
		expect(open).not.toHaveBeenCalled();
	});
	it("retains rate limiting before authentication", async () => {
		const { routes, open } = setup(false);
		vi.mocked(authenticateNative).mockClear();
		await checked(await routes.handle(request()), 429, {
			code: "rate-limited",
		});
		expect(authenticateNative).not.toHaveBeenCalled();
		expect(open).not.toHaveBeenCalled();
	});
	it.each([
		"{",
		"[]",
		JSON.stringify({ ...input, taskId: "t" }),
		JSON.stringify({ ...input, pad: "x".repeat(1024) }),
	])("rejects malformed/oversized/caller-directed bodies %#", async (body) => {
		const { routes, open } = setup();
		await checked(await routes.handle(request(body)), 400, {
			code: "invalid-body",
		});
		expect(open).not.toHaveBeenCalled();
	});
});

function desktopRequest(
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return new Request(`http://localhost/api/native/push/desktop/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			authorization: "Bearer token",
			"content-type": "application/json",
			...headers,
		},
		...(body === undefined
			? {}
			: { body: typeof body === "string" ? body : JSON.stringify(body) }),
	});
}
describe("desktop push routes", () => {
	it("reports desktop readiness separately and preserves exact Android config", async () => {
		const { routes } = setup();
		await checked(await routes.handle(desktopRequest("config")), 200, {
			deliveryReady: true,
		});
		await checked(
			await routes.handle(
				new Request("http://localhost/api/native/push/config", {
					headers: { authorization: "Bearer token" },
				}),
			),
			200,
			{
				deliveryReady: false,
				providers: { unifiedpush: false, fcm: false },
				vapidPublicKey: null,
				fcmProjectId: null,
			},
		);
		const disabled = setup(true, false).routes;
		await checked(await disabled.handle(desktopRequest("config")), 200, {
			deliveryReady: false,
		});
		await checked(await disabled.handle(desktopRequest("register", {})), 409, {
			code: "provider-unavailable",
		});
	});
	it("enrolls the exact server-chosen provider and returns only opaque polled IDs", async () => {
		const { routes } = setup();
		const register = vi
			.spyOn(NativePushStore.prototype, "register")
			.mockResolvedValue({ registrationId: "r", provider: "desktop" });
		const messages = [
			{ version: "1" as const, notificationId: "n", registrationId: "r" },
		];
		const poll = vi
			.spyOn(NativePushStore.prototype, "pollDesktop")
			.mockResolvedValue(messages);
		const receipt = vi
			.spyOn(NativePushStore.prototype, "receiptDesktop")
			.mockResolvedValue(true);
		await checked(await routes.handle(desktopRequest("register", {})), 200, {
			registrationId: "r",
			provider: "desktop",
		});
		expect(register).toHaveBeenCalledWith(owner, { provider: "desktop" });
		await checked(
			await routes.handle(desktopRequest("poll", { registrationId: "r" })),
			200,
			{ messages },
		);
		expect(poll).toHaveBeenCalledWith(owner, "r");
		await checked(await routes.handle(desktopRequest("receipt", input)), 200, {
			received: true,
		});
		expect(receipt).toHaveBeenCalledWith(owner, input);
	});
	it.each([
		"poll",
		"receipt",
	])("hides foreign, stale and wrong-provider %s capabilities", async (path) => {
		const { routes } = setup();
		vi.spyOn(NativePushStore.prototype, "pollDesktop").mockResolvedValue(null);
		vi.spyOn(NativePushStore.prototype, "receiptDesktop").mockResolvedValue(
			false,
		);
		await checked(
			await routes.handle(
				desktopRequest(path, path === "poll" ? { registrationId: "r" } : input),
			),
			404,
			{ code: "notification-unavailable" },
		);
	});
	it.each([
		"config",
		"register",
		"poll",
		"receipt",
		"unregister",
	])("retains authentication, rate limit and browser credential refusal for %s", async (path) => {
		const body =
			path === "config"
				? undefined
				: path === "register"
					? {}
					: path === "poll" || path === "unregister"
						? { registrationId: "r" }
						: input;
		for (const header of ["cookie", "origin"]) {
			const { routes } = setup();
			vi.mocked(authenticateNative).mockClear();
			await checked(
				await routes.handle(desktopRequest(path, body, { [header]: "" })),
				400,
				{ code: "credentials-not-allowed" },
			);
			expect(authenticateNative).not.toHaveBeenCalled();
		}
		const denied = setup(false).routes;
		vi.mocked(authenticateNative).mockClear();
		await checked(await denied.handle(desktopRequest(path, body)), 429, {
			code: "rate-limited",
		});
		expect(authenticateNative).not.toHaveBeenCalled();
		const unauthenticated = setup().routes;
		vi.mocked(authenticateNative).mockResolvedValue(null);
		await checked(
			await unauthenticated.handle(desktopRequest(path, body)),
			401,
			{ code: "unauthorized" },
		);
	});
	it.each([
		["register", { provider: "desktop" }],
		["register", { endpoint: "https://example.test" }],
		["poll", { registrationId: "r", userId: "u" }],
		["poll", { registrationId: "" }],
		["receipt", { ...input, taskId: "t" }],
		["receipt", { registrationId: "r" }],
		["unregister", {}],
		["unregister", { registrationId: "r", userId: "u" }],
		["unregister", { registrationId: "" }],
		["poll", "{"],
		["register", "[]"],
	])("rejects malformed and caller-directed %s input", async (path, body) => {
		const { routes } = setup();
		await checked(
			await routes.handle(desktopRequest(path as string, body)),
			400,
			{ code: "invalid-body" },
		);
	});
	it("revalidates live authority after native admission", async () => {
		const { routes } = setup();
		vi.spyOn(NativePushStore.prototype, "pollDesktop").mockRejectedValue(
			new PushAuthorityError(),
		);
		await checked(
			await routes.handle(desktopRequest("poll", { registrationId: "r" })),
			401,
			{ code: "unauthorized" },
		);
	});
});

describe("desktop registration retirement", () => {
	it("retires only the captured ID without an encryption ring and permits an idempotent repeat", async () => {
		const { routes } = setup(true, false);
		const retire = vi
			.spyOn(NativePushStore.prototype, "unregisterDesktop")
			.mockResolvedValue();
		const generic = vi.spyOn(NativePushStore.prototype, "unregister");
		for (let count = 0; count < 2; count++)
			await checked(
				await routes.handle(
					desktopRequest("unregister", { registrationId: "old" }),
				),
				200,
				{ unregistered: true },
			);
		expect(retire).toHaveBeenCalledTimes(2);
		expect(retire).toHaveBeenCalledWith(owner, "old");
		expect(generic).not.toHaveBeenCalled();
	});
	it("rejects retirement when native authority expires after admission", async () => {
		const { routes } = setup();
		vi.spyOn(NativePushStore.prototype, "unregisterDesktop").mockRejectedValue(
			new PushAuthorityError(),
		);
		await checked(
			await routes.handle(
				desktopRequest("unregister", { registrationId: "old" }),
			),
			401,
			{ code: "unauthorized" },
		);
	});
});
