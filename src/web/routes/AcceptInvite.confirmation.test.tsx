import type { ReactElement, ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";

const hooks = vi.hoisted(() => ({
	slots: [] as unknown[],
	cursor: 0,
	effects: [] as Array<() => unknown>,
	session: true,
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: (initial: unknown) => {
		const index = hooks.cursor++;
		if (!(index in hooks.slots))
			hooks.slots[index] = typeof initial === "function" ? initial() : initial;
		return [
			hooks.slots[index],
			(value: unknown) => {
				hooks.slots[index] =
					typeof value === "function" ? value(hooks.slots[index]) : value;
			},
		];
	},
	useRef: (initial: unknown) => {
		const index = hooks.cursor++;
		hooks.slots[index] ??= { current: initial };
		return hooks.slots[index];
	},
	useId: () => "field",
	useCallback: (callback: unknown) => callback,
	useEffect: (effect: () => unknown, deps: unknown[]) => {
		const index = hooks.cursor++;
		const previous = hooks.slots[index] as unknown[] | undefined;
		if (!previous || deps.some((value, i) => !Object.is(value, previous[i])))
			hooks.effects.push(effect);
		hooks.slots[index] = deps;
	},
}));
vi.mock("../lib/auth-client.ts", () => ({
	authClient: {
		useSession: () => ({
			data: hooks.session ? { user: { id: "joiner" } } : null,
			isPending: false,
		}),
	},
}));
vi.mock("../lib/e2e/KeyringProvider.tsx", () => ({
	KeyringProvider: ({ children }: { children: ReactNode }) => children,
	useKeyring: () => ({ ready: true, state: "unenrolled" }),
}));
vi.mock("./Login.tsx", () => ({ Login: () => null }));
vi.mock("../../domain/e2e/invite-fragment.ts", () => ({
	openInviteFragment: vi.fn(async () => new Uint8Array(32)),
}));
vi.mock("../../domain/e2e/wdk-commitment.ts", () => ({
	verifyWdkCommitment: vi.fn(async () => {}),
}));
vi.mock("../../paraglide/runtime.js", async (original) => ({
	...(await original<typeof import("../../paraglide/runtime.js")>()),
	getLocale: () => "en",
}));

import { openInviteFragment } from "../../domain/e2e/invite-fragment.ts";
import {
	AcceptInvite,
	captureFastInvite,
	tokenFromLocation,
} from "./AcceptInvite.tsx";
import { Login } from "./Login.tsx";

function resetHooks() {
	hooks.slots = [];
	hooks.cursor = 0;
	hooks.effects = [];
}
afterEach(() => {
	resetHooks();
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
function location(href: string, values = new Map<string, string>()) {
	const assign = vi.fn();
	const browser = { location: Object.assign(new URL(href), { assign }) };
	vi.stubGlobal("window", browser);
	vi.stubGlobal("history", {
		state: null,
		replaceState: (_s: unknown, _title: string, url: string) => {
			browser.location = Object.assign(new URL(url, browser.location), {
				assign,
			});
		},
	});
	vi.stubGlobal("sessionStorage", {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
	});
	return { browser, values };
}
function render(): ReactElement {
	hooks.cursor = 0;
	let tree = AcceptInvite();
	while (typeof tree.type === "function")
		tree = (tree.type as (props: unknown) => ReactElement)(tree.props);
	return tree;
}
function find(
	tree: ReactNode,
	match: (element: ReactElement) => boolean,
): ReactElement | undefined {
	if (!tree || typeof tree !== "object" || !("props" in tree)) return;
	const element = tree as ReactElement<{ children?: ReactNode }>;
	if (match(element)) return element;
	for (const child of [element.props.children].flat()) {
		const found = find(child, match);
		if (found) return found;
	}
}
const id = (tree: ReactNode, name: string) =>
	find(
		tree,
		(element) =>
			(element.props as { "data-testid"?: string })["data-testid"] === name,
	);
async function flushEffects() {
	for (const effect of hooks.effects.splice(0)) await effect();
	await Promise.resolve();
}

test.each([
	["https://todo.example/accept#token=bearer&proof=mailbox-proof", true],
	["https://todo.example/accept#confirm=email&proof=mailbox-proof", true],
	["https://todo.example/accept#confirm=email&proof=mailbox-proof", false],
] as const)("fresh confirmation tab verifies without joining, then original tab keeps its fragment: %s (session %s)", async (href, signedIn) => {
	const original = location(
		"https://todo.example/accept?e2e=sealed#token=bearer&e2e=secret",
	);
	captureFastInvite("bearer");
	const fresh = location(href);
	hooks.session = signedIn;
	const fetcher = vi.fn(async (path: string) =>
		Response.json(
			path.endsWith("preview")
				? { valid: true, workspaceName: "Shared" }
				: path.endsWith("claim")
					? {
							inviteId: "invite",
							workspaceId: "workspace",
							userId: "joiner",
							intendedEmail: "joiner@example.test",
							expiresAt: "2026-11-06T17:00:00Z",
							keyVersion: 1,
							commitment: "commitment",
							grantRequestId: "request",
							grantState: "pending",
						}
					: { verified: true, workspaceId: "workspace" },
		),
	);
	vi.stubGlobal("fetch", fetcher);
	render();
	await flushEffects();
	let tree = render();
	if (!signedIn) {
		const login = find(tree, (element) => element.type === Login);
		expect(login?.props).toMatchObject({
			callbackURL: "/accept#confirm=email&proof=mailbox-proof",
		});
		expect(fetcher).not.toHaveBeenCalled();
		hooks.session = true;
		tree = render();
	}
	const button = id(tree, "accept-confirm-email") ?? id(tree, "accept-join");
	if (!button) throw new Error("confirmation action missing");
	(button.props as { onClick: () => void }).onClick();
	await vi.waitFor(() =>
		expect(
			fetcher.mock.calls.some(([path]) => path === "/api/invite/verify-email"),
		).toBe(true),
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(fetcher.mock.calls.map(([path]) => path)).not.toContain(
		"/api/invite/accept",
	);
	expect(fetcher.mock.calls.map(([path]) => path)).not.toContain(
		"/api/invite/claim",
	);
	expect(id(render(), "accept-join")).toBeUndefined();
	expect(fresh.browser.location.hash).toBe("#confirm=email");
	expect(fresh.values.size).toBe(0);
	resetHooks();
	expect(id(render(), "invite-mailbox-confirmation")).toBeDefined();
	expect(id(render(), "accept-join")).toBeUndefined();

	location(original.browser.location.href, original.values);
	resetHooks();
	render();
	await flushEffects();
	await vi.waitFor(() =>
		expect(openInviteFragment).toHaveBeenCalledWith(
			"secret",
			"sealed",
			expect.objectContaining({ workspaceId: "workspace" }),
		),
	);
	expect(tokenFromLocation()).toBe("bearer");
	expect(fetcher.mock.calls.map(([path]) => path)).toContain(
		"/api/invite/claim",
	);
	expect(fetcher.mock.calls.map(([path]) => path)).not.toContain(
		"/api/invite/accept",
	);
});
