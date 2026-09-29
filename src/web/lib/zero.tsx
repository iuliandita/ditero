import { Zero } from "@rocicorp/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import { ShellSkeleton } from "../components/shell/AppSkeleton.tsx";
import { fetchPublicConfig } from "./public-config.ts";
import {
	createSyncTracker,
	OFFLINE_EDIT_WINDOW_MS,
	type SyncTracker,
	trackMutations,
} from "./sync-status.ts";
import { fetchZeroToken, watchZeroAuth } from "./zero-auth.ts";

async function repairAccountBootstrap(): Promise<void> {
	const res = await fetch("/api/bootstrap", {
		method: "POST",
		credentials: "include",
	});
	if (!res.ok) throw new Error(`account bootstrap failed: ${res.status}`);
}

// Client-side context ({ id }) is passed for optimistic synced-query evaluation;
// the server re-derives the authoritative ctx from the JWT. Let TS infer the full
// Zero generic from the constructor rather than restating it.
function createZeroClient(userID: string, token: string, cacheURL: string) {
	return new Zero({
		cacheURL,
		userID,
		schema,
		mutators,
		auth: token,
		context: { id: userID },
		disconnectTimeoutMs: OFFLINE_EDIT_WINDOW_MS,
	});
}
type ZeroClient = ReturnType<typeof createZeroClient>;

const SyncTrackerContext = createContext<SyncTracker | null>(null);

export function useSyncTracker(): SyncTracker {
	const tracker = useContext(SyncTrackerContext);
	if (!tracker) throw new Error("useSyncTracker outside AppZeroProvider");
	return tracker;
}

export function AppZeroProvider({
	userID,
	children,
}: {
	userID: string;
	children: ReactNode;
}) {
	const [client, setClient] = useState<{
		zero: ZeroClient;
		tracker: SyncTracker;
	} | null>(null);

	useEffect(() => {
		let instance: ZeroClient | undefined;
		let stopAuthRefresh: (() => void) | undefined;
		let stopConnectionWatch: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			await repairAccountBootstrap();
			const [config, token] = await Promise.all([
				fetchPublicConfig(),
				fetchZeroToken(),
			]);
			if (cancelled) return;
			instance = createZeroClient(userID, token, config.zeroURL);
			const tracker = createSyncTracker();
			trackMutations(instance, tracker);
			stopConnectionWatch = instance.connection.state.subscribe((state) => {
				if (state.name === "connected") tracker.connected();
			});
			stopAuthRefresh = watchZeroAuth(instance, undefined, undefined, {
				onSessionExpired: tracker.setSessionExpired,
			});
			setClient({ zero: instance, tracker });
		})().catch((error) => {
			if (!cancelled) console.error("Zero startup failed", error);
		});
		return () => {
			cancelled = true;
			stopAuthRefresh?.();
			stopConnectionWatch?.();
			instance?.close();
			setClient(null);
		};
	}, [userID]);

	if (!client) return <ShellSkeleton />;
	return (
		<ZeroProvider zero={client.zero}>
			<SyncTrackerContext.Provider value={client.tracker}>
				{children}
			</SyncTrackerContext.Provider>
		</ZeroProvider>
	);
}
