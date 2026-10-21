import { beforeAll, beforeEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
	receive: undefined as ((data: string) => void) | undefined,
	invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: host.invoke,
	Channel: class {
		set onmessage(fn: (data: string) => void) {
			host.receive = fn;
		}
	},
}));
vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ onCloseRequested: vi.fn() }),
}));
vi.mock("../../../src/paraglide/runtime.js", () => ({
	getLocale: () => "en",
}));

import { connectBridge, readProfile } from "../../android/src/bridge.ts";
import {
	captureVerifiedContext,
	createNativeRuntime,
} from "../../android/src/runtime.ts";
import { installTransport } from "./transport.ts";

const origin = "https://todo.example.test";
const session = {
	scope: `native:${JSON.stringify([origin, "user-1"])}`,
	userId: "user-1",
	deviceId: "device-1",
	authHandle: "opaque-desktop-session",
	expiresAt: "2099-01-01T00:00:00Z",
	tokenReady: false,
	jwtExp: 0,
};
let refusal: { op: string; code: string } | undefined;
let commands: string[];

beforeAll(async () => {
	host.invoke.mockImplementation(async (name: string) => {
		if (name === "native_attach") return 7;
	});
	await installTransport();
});
beforeEach(async () => {
	refusal = undefined;
	commands = [];
	host.invoke.mockImplementation(
		async (name: string, args: { message: string; page: number }) => {
			expect(name).toBe("native_post");
			expect(args.page).toBe(7);
			const request = JSON.parse(args.message) as { op: string; rid: number };
			commands.push(request.op);
			const fields: Record<string, Record<string, unknown>> = {
				hello: {
					gen: 1,
					server: {
						origin,
						queryUrl: `${origin}/api/zero/query`,
						mutateUrl: `${origin}/api/zero/mutate`,
					},
					session,
				},
				"session.read": session,
				"profile.read": {
					id: "user-1",
					name: "Alex",
					email: "alex@example.test",
				},
				"bootstrap.ensure": { workspaceId: "workspace-1" },
				"config.read": {
					origin,
					queryUrl: `${origin}/api/zero/query`,
					mutateUrl: `${origin}/api/zero/mutate`,
					zeroURL: "https://zero.example.test",
				},
				refresh: { ok: false, code: "offline-ready" },
			};
			const reply =
				refusal?.op === request.op
					? { ok: false, code: refusal.code }
					: fields[request.op];
			expect(reply).toBeDefined();
			host.receive?.(
				JSON.stringify({ t: "reply", rid: request.rid, ok: true, ...reply }),
			);
		},
	);
	await connectBridge();
});

test("desktop transport opens the shared runtime using native cached startup replies", async () => {
	const context = await captureVerifiedContext();
	await expect(readProfile()).resolves.toEqual({
		id: "user-1",
		name: "Alex",
		email: "alex@example.test",
	});
	const retireZero = vi.fn(async () => {});
	const runtime = createNativeRuntime(context, {
		retireZero,
		onSessionEnded: vi.fn(),
	});
	await runtime.zero.bootstrap();
	await expect(runtime.zero.fetchConfig()).resolves.toEqual({
		zeroURL: "https://zero.example.test",
	});
	await expect(runtime.zero.getAuth()).resolves.toBe(session.authHandle);
	expect(runtime.zero.storageScope).toBe(session.scope);
	expect(retireZero).not.toHaveBeenCalled();
	expect(commands).toEqual([
		"hello",
		"session.read",
		"profile.read",
		"bootstrap.ensure",
		"config.read",
		"refresh",
	]);
});

test.each([
	"network",
	"transport-refused",
	"session-refused",
	"storage-failed",
])("desktop cannot create a runtime after refused cached session verification: %s", async (code) => {
	refusal = { op: "session.read", code };
	await expect(captureVerifiedContext()).rejects.toMatchObject({ code });
	expect(commands).toEqual(["hello", "session.read"]);
});

test.each([
	"network",
	"transport-refused",
	"token-refused",
	"storage-failed",
])("only native offline-ready can supply an opaque handle after refresh fails: %s", async (code) => {
	const context = await captureVerifiedContext();
	const runtime = createNativeRuntime(context, {
		retireZero: async () => {},
		onSessionEnded: vi.fn(),
	});
	refusal = { op: "refresh", code };
	await expect(runtime.zero.getAuth()).rejects.toMatchObject({ code });
});
