import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { rememberBrowserSession } from "./browser-session.ts";

function createBrowserClient() {
	// Same origin: the vite proxy forwards /api/auth to the server.
	return createAuthClient({
		baseURL: "",
		fetchOptions: {
			onRequest(context) {
				const path = new URL(context.url, window.location.origin).pathname;
				if (
					path.endsWith("/sign-out") ||
					path.endsWith("/delete-user") ||
					path.includes("/sign-in/") ||
					path.includes("/sign-up/")
				)
					rememberBrowserSession(null);
			},
		},
		plugins: [passkeyClient(), twoFactorClient()],
	});
}

type BrowserClient = ReturnType<typeof createBrowserClient>;
let browserClient: BrowserClient | undefined;

// Native bundles import shared modules, but cookie authentication belongs to the browser.
export const authClient = new Proxy({} as BrowserClient, {
	get(_target, property) {
		if ("NativeDitero" in globalThis) {
			throw new Error("Browser authentication is unavailable in native mode");
		}
		browserClient ??= createBrowserClient();
		return Reflect.get(browserClient, property, browserClient);
	},
});
