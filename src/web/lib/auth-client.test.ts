import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	passkey: vi.fn(() => ({ id: "passkey" })),
	twoFactor: vi.fn(() => ({ id: "two-factor" })),
}));
vi.mock("better-auth/react", () => ({ createAuthClient: mocks.create }));
vi.mock("@better-auth/passkey/client", () => ({
	passkeyClient: mocks.passkey,
}));
vi.mock("better-auth/client/plugins", () => ({
	twoFactorClient: mocks.twoFactor,
}));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

it.each([
	"tauri://localhost",
	"https://localhost",
])("imports safely at native origin %s and refuses cookie APIs before construction", async (origin) => {
	vi.stubGlobal("window", { location: { origin } });
	const fetch = vi.fn();
	vi.stubGlobal("fetch", fetch);
	const { authClient } = await import("./auth-client.ts");
	expect(mocks.create).not.toHaveBeenCalled();
	// The transport is attached after shared modules have been imported.
	vi.stubGlobal("NativeDitero", {});
	expect(() => authClient.useSession()).toThrow("unavailable in native mode");
	expect(() => authClient.signOut()).toThrow("unavailable in native mode");
	expect(mocks.create).not.toHaveBeenCalled();
	expect(mocks.passkey).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
});

it.each([
	true,
	false,
])("creates one same-origin browser client and delegates plugin APIs (window: %s)", async (withWindow) => {
	if (withWindow)
		vi.stubGlobal("window", { location: { origin: "https://app.example" } });
	const passkey = vi.fn().mockResolvedValue({ data: "passkey-result" });
	const client = {
		signIn: { passkey },
		useSession: vi.fn(() => ({ data: null })),
	};
	mocks.create.mockReturnValue(client);
	const { authClient } = await import("./auth-client.ts");
	expect(mocks.create).not.toHaveBeenCalled();
	expect(await authClient.signIn.passkey()).toEqual({ data: "passkey-result" });
	expect(passkey.mock.contexts[0]).toBe(client.signIn);
	expect(authClient.useSession()).toEqual({ data: null });
	expect(mocks.create).toHaveBeenCalledTimes(1);
	expect(mocks.create).toHaveBeenCalledWith({
		baseURL: "",
		plugins: [{ id: "passkey" }, { id: "two-factor" }],
	});
	vi.stubGlobal("NativeDitero", {});
	expect(() => authClient.useSession()).toThrow("unavailable in native mode");
	expect(client.useSession).toHaveBeenCalledTimes(1);
});
