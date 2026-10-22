import {
	type StorageFailureError,
	Zero,
	type ZeroOptions,
} from "@rocicorp/zero";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import { OFFLINE_EDIT_WINDOW_MS } from "./sync-status.ts";

// Client-side context ({ id }) is passed for optimistic synced-query evaluation;
// the server re-derives the authoritative ctx from the JWT. Let TS infer the full
// Zero generic from the constructor rather than restating it. userID stays the
// canonical account ID; only a verified native scope may change Zero's storageKey.
// kvStore is a test seam; the app uses Zero's IndexedDB default.
export function createZeroClient({
	userID,
	token,
	cacheURL,
	storageKey,
	onStorageFailure,
	kvStore,
}: {
	userID: string;
	token: string;
	cacheURL: string;
	storageKey?: string;
	onStorageFailure: (failure: StorageFailureError) => void;
	kvStore?: ZeroOptions["kvStore"];
}) {
	return new Zero({
		cacheURL,
		userID,
		storageKey,
		schema,
		mutators,
		auth: token,
		context: { id: userID },
		disconnectTimeoutMs: OFFLINE_EDIT_WINDOW_MS,
		onStorageFailure,
		kvStore,
	});
}
export type ZeroClient = ReturnType<typeof createZeroClient>;
