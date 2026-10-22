import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
	BASE,
	finishOAuth,
	json,
	memoryAuth,
	mockProviderEndpoints,
	signedInUser,
	startOAuth,
} from "../../../../tests/support/oauth-mocks.ts";

const state = vi.hoisted(() => ({
	values: [] as unknown[],
	cursor: 0,
	effects: [] as (() => void)[],
	listAccounts: vi.fn(),
	unlinkAccount: vi.fn(),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useEffect: (effect: () => void) => state.effects.push(effect),
	useState: (initial: unknown) => {
		const index = state.cursor++;
		if (!(index in state.values))
			state.values[index] = typeof initial === "function" ? initial() : initial;
		return [
			state.values[index],
			(value: unknown) => {
				state.values[index] = value;
			},
		];
	},
}));
vi.mock("../../../paraglide/runtime.js", async (original) => ({
	...(await original<typeof import("../../../paraglide/runtime.js")>()),
	getLocale: () => "en",
}));
vi.mock("../../lib/auth-client.ts", () => ({
	authClient: {
		listAccounts: state.listAccounts,
		unlinkAccount: state.unlinkAccount,
	},
}));
vi.mock("../../lib/public-config.ts", () => ({
	fetchPublicConfig: async () => ({ socialProviders: ["github"] }),
}));

import { LinkedProvidersPanel } from "./LinkedProvidersPanel.tsx";

function button(
	tree: ReactElement | null,
	text: string,
): (() => Promise<void>) | undefined {
	if (!tree) return;
	const props = tree.props as {
		onClick?: () => Promise<void>;
		children?: ReactElement | ReactElement[] | string;
	};
	if (props.onClick && props.children === text) return props.onClick;
	for (const child of [props.children].flat()) {
		if (child && typeof child === "object" && "props" in child) {
			const found = button(child, text);
			if (found) return found;
		}
	}
}
function render() {
	state.cursor = 0;
	return LinkedProvidersPanel();
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
	state.values.length = 0;
	state.effects.length = 0;
});

test("the panel unlinks the listed local row through the real Better Auth endpoint", async () => {
	vi.stubGlobal("window", { location: { search: "" } });
	const h = memoryAuth({
		env: { GITHUB_CLIENT_ID: "gh-id", GITHUB_CLIENT_SECRET: "gh-secret" },
	});
	const session = await signedInUser(h.auth, "owner@example.test");
	mockProviderEndpoints([
		(r) =>
			r.url.hostname === "github.com"
				? json({ access_token: "token", token_type: "bearer" })
				: undefined,
		(r) =>
			r.url.pathname === "/user"
				? json({ id: 4242, login: "ada", email: null })
				: undefined,
		(r) =>
			r.url.pathname === "/user/emails"
				? json([{ email: "ada@example.test", verified: true, primary: true }])
				: undefined,
	]);
	const started = await startOAuth(h.auth, "github", { session, link: true });
	expect((await finishOAuth(h.auth, "github", started)).error).toBeNull();
	const cookie = [...session]
		.map(([key, value]) => `${key}=${value}`)
		.join("; ");
	const request = (path: string, body?: unknown) =>
		h.auth.handler(
			new Request(`${BASE}/api/auth/${path}`, {
				method: body ? "POST" : "GET",
				headers: { cookie, origin: BASE, "content-type": "application/json" },
				...(body ? { body: JSON.stringify(body) } : {}),
			}),
		);
	state.listAccounts.mockImplementation(async () => ({
		data: await (await request("list-accounts")).json(),
	}));
	state.unlinkAccount.mockImplementation(async (body: unknown) => {
		const response = await request("unlink-account", body);
		return response.ok
			? { data: await response.json() }
			: { error: await response.json() };
	});
	render();
	for (const effect of state.effects) effect();
	await vi.waitFor(() =>
		expect(state.values[1]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ providerId: "github", accountId: "4242" }),
			]),
		),
	);
	const linked = h.store.account.find((a) => a.providerId === "github");
	expect(linked?.id).not.toBe("4242");
	const unlink = button(render(), "Unlink GitHub");
	expect(unlink).toBeDefined();
	await unlink?.();
	const confirm = button(render(), "Confirm unlinking GitHub");
	expect(confirm).toBeDefined();
	await confirm?.();
	await vi.waitFor(() =>
		expect(h.store.account.some((a) => a.providerId === "github")).toBe(false),
	);
	expect(state.unlinkAccount).toHaveBeenCalledWith({
		accountId: linked?.id,
	});
	expect(h.store.account.some((a) => a.providerId === "credential")).toBe(true);
});
