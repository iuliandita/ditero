import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { ConnectionRequiredError } from "./lib/connection-required.ts";

const session = vi.hoisted(() => ({
	data: null,
	isPending: false,
	error: null as unknown,
	refetch: vi.fn(),
}));
vi.mock("./lib/auth-client.ts", () => ({
	authClient: { useSession: () => session },
}));
vi.mock("./routes/Login.tsx", () => ({
	Login: () => <form data-testid="signin" />,
}));
vi.mock("./routes/Workspace.tsx", () => ({ Workspace: () => null }));
vi.mock("./routes/AcceptInvite.tsx", () => ({ AcceptInvite: () => null }));
vi.mock("./routes/NativeAuthorize.tsx", () => ({
	NativeAuthorize: () => null,
}));
vi.mock("./lib/zero.tsx", () => ({
	AppZeroProvider: () => {
		throw new Error("Zero must not start");
	},
}));
vi.mock("./lib/DisplayPreferencesProvider.tsx", () => ({
	DisplayPreferencesProvider: ({ children }: { children: ReactNode }) =>
		children,
	SyncedDisplayPreferencesProvider: () => null,
}));

import { App } from "./App.tsx";

afterEach(() => {
	vi.unstubAllGlobals();
});

test.each([
	[new ConnectionRequiredError("network"), true],
	[{ status: 0 }, true],
	[{ status: 401 }, false],
	[{ status: 403 }, false],
	[{ status: 500 }, false],
	[{ status: 503 }, false],
	[null, false],
])("session startup decision for %s preserves login only after an HTTP response", (error, needsConnection) => {
	vi.stubGlobal("window", { location: { pathname: "/" } });
	vi.stubGlobal("navigator", { onLine: false });
	vi.stubGlobal("document", { cookie: "PARAGLIDE_LOCALE=en" });
	vi.stubGlobal("localStorage", { getItem: () => "en", setItem: vi.fn() });
	session.error = error;
	const html = renderToStaticMarkup(<App />);
	expect(html.includes("Ditero needs a connection to open")).toBe(
		needsConnection,
	);
	expect(html.includes('data-testid="signin"')).toBe(!needsConnection);
	if (needsConnection) {
		expect(html).toContain("<h1");
		expect(html).toContain(">Retry</button>");
	}
});
