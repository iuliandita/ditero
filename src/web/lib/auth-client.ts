import { passkeyClient } from "@better-auth/passkey/client";
import { twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same origin: the vite proxy forwards /api/auth to the server.
export const authClient = createAuthClient({
	baseURL: "",
	plugins: [passkeyClient(), twoFactorClient()],
});
