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
