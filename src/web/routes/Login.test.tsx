import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
	verifyTotp: vi.fn(),
	verifyBackupCode: vi.fn(),
}));
vi.mock("../../paraglide/runtime.js", async (original) => ({
	...(await original<typeof import("../../paraglide/runtime.js")>()),
	getLocale: () => "en",
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useEffect: () => {},
	useRef: (value: unknown) => ({ current: value }),
	useState: (initial: unknown) => [
		typeof initial === "function" ? initial() : initial,
		() => {},
	],
}));
vi.mock("../lib/auth-client.ts", () => ({ authClient: { twoFactor: state } }));
vi.mock("../lib/zero-lifecycle.ts", () => ({
	runAfterZeroRetirement: (action: () => Promise<void>) => action(),
	ZeroRetirementError: class extends Error {},
	retirementErrorMessage: () => "Failed",
}));

import { Login } from "./Login.tsx";

function form(
	tree: ReactElement,
	id: string,
): ((event: { preventDefault: () => void }) => void) | undefined {
	const props = tree.props as {
		"data-testid"?: string;
		onSubmit?: (event: { preventDefault: () => void }) => void;
		children?: ReactElement | ReactElement[];
	};
	const children = [props.children]
		.flat()
		.filter(
			(child): child is ReactElement =>
				Boolean(child) && typeof child === "object" && "props" in child,
		);
	if (
		props.onSubmit &&
		children.some(
			(child) =>
				(child.props as { "data-testid"?: string })["data-testid"] === id,
		)
	)
		return props.onSubmit;
	for (const child of children) {
		const found = form(child, id);
		if (found) return found;
	}
}
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
test.each([
	"totp",
	"backup",
])("%s completion returns to native approval with its original grant", async (method) => {
	const assign = vi.fn();
	vi.stubGlobal("window", {
		location: { origin: "https://app.example.test", search: "", assign },
	});
	state.verifyTotp.mockResolvedValue({
		data: { token: "session" },
		error: null,
	});
	state.verifyBackupCode.mockResolvedValue({
		data: { token: "session" },
		error: null,
	});
	const callbackURL =
		"/native/authorize?grantId=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
	const action = form(
		Login({ twoFactor: true, callbackURL }),
		method === "totp" ? "verify-totp" : "verify-backup-code",
	);
	expect(action).toBeTypeOf("function");
	action?.({ preventDefault: () => {} });
	await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(callbackURL));
	expect(
		method === "totp" ? state.verifyTotp : state.verifyBackupCode,
	).toHaveBeenCalledOnce();
});
