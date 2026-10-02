import { authClient } from "../auth-client.ts";
import type { CiphertextStageRunner, DownloadDestination } from "./download.ts";
import type { E2eFetcher } from "./workspace-keys.ts";

export type AttachmentRuntime = {
	readonly fetcher: E2eFetcher;
	readonly pickFile: (
		filename: string,
		signal?: AbortSignal,
	) => Promise<DownloadDestination>;
	readonly withStage: CiphertextStageRunner;
};

export type E2eRuntime = {
	readonly fetcher: E2eFetcher;
	readonly attachments?: AttachmentRuntime;
	readonly signOut: () => Promise<void>;
};

export const browserE2eRuntime: E2eRuntime = {
	fetcher: (input, init) => fetch(input, init),
	async signOut() {
		const result = await authClient.signOut();
		if (result.error) throw result.error;
	},
};
