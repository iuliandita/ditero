import { Zero } from "@rocicorp/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import { ShellSkeleton } from "../components/shell/AppSkeleton.tsx";
import { Button } from "../components/ui/button.tsx";
import { fetchPublicConfig } from "./public-config.ts";
import {
	createSyncTracker,
	OFFLINE_EDIT_WINDOW_MS,
	type SyncTracker,
	trackMutations,
} from "./sync-status.ts";
import { fetchZeroToken, watchZeroAuth } from "./zero-auth.ts";
import {
	createAfterZeroRetirement,
	registerZeroClient,
	retireZeroClients,
	ZeroRetirementError,
} from "./zero-lifecycle.ts";

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
	const [startupFailed, setStartupFailed] = useState(false);
	const [startupSaveFailed, setStartupSaveFailed] = useState(false);
	const [startupAttempt, setStartupAttempt] = useState(0);
	const [retrying, setRetrying] = useState(false);
	const retryPending = useRef(false);

	async function retryStartup() {
		if (retryPending.current) return;
		retryPending.current = true;
		setRetrying(true);
		try {
			await retireZeroClients();
			setStartupFailed(false);
			setStartupAttempt((n) => n + 1);
		} catch {
			setStartupFailed(true);
			setStartupSaveFailed(true);
		} finally {
			retryPending.current = false;
			setRetrying(false);
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry must restart initialization even when the account is unchanged.
	useEffect(() => {
		let owner: ReturnType<typeof registerZeroClient> | undefined;
		let stopAuthRefresh: (() => void) | undefined;
		let stopConnectionWatch: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			await repairAccountBootstrap();
			const [config, token] = await Promise.all([
				fetchPublicConfig(),
				fetchZeroToken(),
			]);
			const created = await createAfterZeroRetirement(
				() => {
					const instance = createZeroClient(userID, token, config.zeroURL);
					owner = registerZeroClient(
						userID,
						instance,
						() => {
							stopAuthRefresh?.();
							stopConnectionWatch?.();
						},
						() => cancelled,
					);
					const tracker = createSyncTracker();
					trackMutations(instance, tracker);
					stopConnectionWatch = instance.connection.state.subscribe((state) => {
						if (state.name === "connected") tracker.connected();
					});
					stopAuthRefresh = watchZeroAuth(instance, undefined, undefined, {
						onSessionExpired: tracker.setSessionExpired,
						onAuthRejected: tracker.setAuthRejected,
					});
					return { zero: instance, tracker };
				},
				() => cancelled,
			);
			if (created && !cancelled) setClient(created);
		})().catch(async (error: unknown) => {
			let saveFailed = error instanceof ZeroRetirementError;
			if (owner) {
				try {
					await owner.retire();
				} catch {
					saveFailed = true;
				}
			}
			if (!cancelled) {
				console.error("Zero startup failed", error);
				setStartupFailed(true);
				setStartupSaveFailed(saveFailed);
			}
		});
		return () => {
			cancelled = true;
			void owner?.retire().catch((error: unknown) => {
				console.error("Zero retirement failed", error);
			});
			setClient(null);
		};
	}, [userID, startupAttempt]);

	if (startupFailed)
		return (
			<main className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6">
				<p role="alert">
					{startupSaveFailed
						? m.sync_save_pending_failed()
						: m.mutation_failed()}
				</p>
				<Button disabled={retrying} onClick={() => void retryStartup()}>
					{m.action_retry()}
				</Button>
			</main>
		);
	if (!client) return <ShellSkeleton />;
	return (
		<ZeroProvider zero={client.zero}>
			<SyncTrackerContext.Provider value={client.tracker}>
				{children}
			</SyncTrackerContext.Provider>
		</ZeroProvider>
	);
}
