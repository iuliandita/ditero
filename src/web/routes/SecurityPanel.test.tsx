import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";

const { enable, writes } = vi.hoisted(() => ({
	enable: vi.fn(),
	writes: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useCallback: (callback: unknown) => callback,
	useEffect: () => {},
	useId: () => "security-password",
	useState: (initial: unknown) => [
		initial,
		(value: unknown) => writes.push(value),
	],
}));
vi.mock("../lib/auth-client.ts", () => ({
	authClient: { useSession: () => ({ data: null }), twoFactor: { enable } },
}));
vi.mock("../components/e2e/EncryptedFilesPanel.tsx", () => ({
	EncryptedFilesPanel: () => null,
}));

import { SecurityPanel } from "./SecurityPanel.tsx";

function enableButton(tree: ReactElement): (() => void) | undefined {
	const props = tree.props as {
		"data-testid"?: string;
		onClick?: () => void;
		children?: ReactElement | ReactElement[];
	};
	if (props["data-testid"] === "enable-2fa" && props.onClick)
		return props.onClick;
	for (const child of [props.children].flat()) {
		if (!child || typeof child !== "object" || !("props" in child)) continue;
		const action = enableButton(child);
		if (action) return action;
	}
	return undefined;
}

afterEach(() => {
	writes.length = 0;
	enable.mockReset();
});

test.each([
	{
		method: "totp",
		totpURI: "otpauth://totp/Ditero?secret=test",
		backupCodes: ["backup"],
	},
	{ method: "otp" },
])("TOTP enrollment handles the $method response before reading setup fields", async (data) => {
	enable.mockResolvedValue({ data, error: null });
	const action = enableButton(SecurityPanel());
	if (!action) throw new Error("Missing TOTP enable action");
	action();
	await vi.waitFor(() =>
		expect(writes).toHaveLength(data.method === "totp" ? 4 : 2),
	);
	expect(enable).toHaveBeenCalledWith({ password: "", method: "totp" });
	if (data.method === "totp") {
		expect(writes).toEqual([null, "", data.totpURI, data.backupCodes]);
	} else {
		expect(writes).toEqual([
			null,
			"Could not enable two-factor authentication",
		]);
	}
});
