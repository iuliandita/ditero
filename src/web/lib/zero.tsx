import { Zero } from "@rocicorp/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import { ShellSkeleton } from "../components/shell/AppSkeleton.tsx";
import { fetchPublicConfig } from "./public-config.ts";
import {
	createPendingMutations,
	OFFLINE_EDIT_WINDOW_MS,
	type PendingMutations,
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

const PendingMutationsContext = createContext<PendingMutations | null>(null);

export function usePendingMutations(): PendingMutations {
	const pending = useContext(PendingMutationsContext);
	if (!pending) throw new Error("usePendingMutations outside AppZeroProvider");
	return pending;
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
		pending: PendingMutations;
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
			const pending = createPendingMutations();
			trackMutations(instance, pending);
			stopConnectionWatch = instance.connection.state.subscribe((state) => {
				if (state.name === "connected") pending.connected();
			});
			stopAuthRefresh = watchZeroAuth(instance);
			setClient({ zero: instance, pending });
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
			<PendingMutationsContext.Provider value={client.pending}>
				{children}
			</PendingMutationsContext.Provider>
		</ZeroProvider>
	);
}
