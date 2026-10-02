import { authClient } from "../auth-client.ts";
import type { E2eFetcher } from "./workspace-keys.ts";

export type E2eRuntime = {
	readonly fetcher: E2eFetcher;
	readonly signOut: () => Promise<void>;
};

export const browserE2eRuntime: E2eRuntime = {
	fetcher: (input, init) => fetch(input, init),
	async signOut() {
		const result = await authClient.signOut();
		if (result.error) throw result.error;
	},
};
