import { Zero } from "@rocicorp/zero";
import { ZeroProvider } from "@rocicorp/zero/react";
import type { ReactNode } from "react";
import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import { schema } from "../../zero/schema.gen.ts";
import { ConnectionRequired } from "../components/ConnectionRequired.tsx";
import { ShellSkeleton } from "../components/shell/AppSkeleton.tsx";
import { Button } from "../components/ui/button.tsx";
import { ConnectionRequiredError } from "./connection-required.ts";
import { createExportBoundary } from "./export-boundary.ts";
import {
	createSyncTracker,
	OFFLINE_EDIT_WINDOW_MS,
	type SyncTracker,
	trackMutations,
} from "./sync-status.ts";
import { watchZeroAuth } from "./zero-auth.ts";
import {
	createAfterZeroRetirement,
	registerZeroClient,
	retireZeroClients,
	ZeroRetirementError,
} from "./zero-lifecycle.ts";
import {
	browserZeroRuntime,
	type ZeroRuntime,
	zeroStorageScope,
} from "./zero-runtime.ts";

// Client-side context ({ id }) is passed for optimistic synced-query evaluation;
// the server re-derives the authoritative ctx from the JWT. Let TS infer the full
// Zero generic from the constructor rather than restating it. userID stays the
// canonical account ID; only a verified native scope may change Zero's storageKey.
function createZeroClient(
	userID: string,
	token: string,
	cacheURL: string,
	storageKey?: string,
) {
	return new Zero({
		cacheURL,
		userID,
		storageKey,
		schema,
		mutators,
		auth: token,
		context: { id: userID },
		disconnectTimeoutMs: OFFLINE_EDIT_WINDOW_MS,
	});
}
type ZeroClient = ReturnType<typeof createZeroClient>;

const SyncEndpointContext = createContext<string | null>(null);
export function useSyncEndpoint(): string | null {
	return useContext(SyncEndpointContext);
}

const SyncTrackerContext = createContext<SyncTracker | null>(null);
const ExportBoundaryContext = createContext<ReturnType<
	typeof createExportBoundary
> | null>(null);

export function useExportBoundary() {
	const boundary = useContext(ExportBoundaryContext);
	if (!boundary) throw new Error("useExportBoundary outside AppZeroProvider");
	return boundary;
}

export function useSyncTracker(): SyncTracker {
	const tracker = useContext(SyncTrackerContext);
	if (!tracker) throw new Error("useSyncTracker outside AppZeroProvider");
	return tracker;
}

export function AppZeroProvider({
	userID,
	runtime = browserZeroRuntime,
	children,
}: {
	userID: string;
	runtime?: ZeroRuntime;
	children: ReactNode;
}) {
	const [client, setClient] = useState<{
		zero: ZeroClient;
		endpoint: string;
		tracker: SyncTracker;
		exportBoundary: ReturnType<typeof createExportBoundary>;
	} | null>(null);
	const [startupFailed, setStartupFailed] = useState(false);
	const [connectionFailed, setConnectionFailed] = useState(false);
	const initializing = useRef(false);
	const [startupSaveFailed, setStartupSaveFailed] = useState(false);
	const [startupAttempt, setStartupAttempt] = useState(0);
	const [retrying, setRetrying] = useState(false);
	const retryPending = useRef(false);

	const retryStartup = useCallback(async () => {
		if (retryPending.current || initializing.current) return;
		retryPending.current = true;
		setRetrying(true);
		try {
			await retireZeroClients();
			if (!connectionFailed) setStartupFailed(false);
			setStartupAttempt((n) => n + 1);
		} catch {
			setStartupFailed(true);
			setStartupSaveFailed(true);
			setConnectionFailed(false);
		} finally {
			retryPending.current = false;
			setRetrying(false);
		}
	}, [connectionFailed]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry must restart initialization even when the account is unchanged.
	useEffect(() => {
		let owner: ReturnType<typeof registerZeroClient> | undefined;
		let stopAuthRefresh: (() => void) | undefined;
		let stopConnectionWatch: (() => void) | undefined;
		let stopExportWatch: (() => void) | undefined;
		let exportBoundary: ReturnType<typeof createExportBoundary> | undefined;
		let cancelled = false;
		initializing.current = true;
		void (async () => {
			const storageScope = zeroStorageScope(runtime);
			await runtime.bootstrap();
			const [config, token] = await Promise.all([
				runtime.fetchConfig(),
				runtime.getAuth(),
			]);
			const created = await createAfterZeroRetirement(
				() => {
					const instance = createZeroClient(
						userID,
						token,
						config.zeroURL,
						storageScope,
					);
					owner = registerZeroClient(
						userID,
						instance,
						() => {
							stopAuthRefresh?.();
							stopConnectionWatch?.();
							stopExportWatch?.();
							exportBoundary?.dispose();
						},
						() => cancelled,
					);
					const tracker = createSyncTracker();
					trackMutations(instance, tracker);
					const boundary = createExportBoundary({
						userID,
						storageScope,
						clientID: instance.clientID,
						isConnected: () =>
							!cancelled &&
							navigator.onLine &&
							instance.connection.state.current.name === "connected",
					});
					exportBoundary = boundary;
					const mutate = instance.mutate as (...args: unknown[]) => {
						client: Promise<unknown>;
						server: Promise<unknown>;
					};
					const guarded = (...args: unknown[]) =>
						boundary.wrapMutation(() => mutate(...args));
					Object.assign(guarded, mutate);
					Object.defineProperty(instance, "mutate", { value: guarded });
					const refreshExport = () => {
						boundary.refreshJournal();
						boundary.connectionChanged();
					};
					window.addEventListener("storage", refreshExport);
					window.addEventListener("offline", refreshExport);
					stopExportWatch = () => {
						window.removeEventListener("storage", refreshExport);
						window.removeEventListener("offline", refreshExport);
					};
					stopConnectionWatch = instance.connection.state.subscribe((state) => {
						if (state.name === "connected") tracker.connected();
						boundary.connectionChanged();
					});
					stopAuthRefresh = watchZeroAuth(
						instance,
						() => runtime.getAuth(),
						undefined,
						{
							onSessionExpired: tracker.setSessionExpired,
							onAuthRejected: tracker.setAuthRejected,
						},
					);
					return {
						zero: instance,
						tracker,
						exportBoundary: boundary,
						endpoint: config.zeroURL,
					};
				},
				() => cancelled,
			);
			if (created && !cancelled) {
				setStartupFailed(false);
				setConnectionFailed(false);
				setClient(created);
			}
		})()
			.catch(async (error: unknown) => {
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
					setConnectionFailed(
						!saveFailed && error instanceof ConnectionRequiredError,
					);
				}
			})
			.finally(() => {
				if (!cancelled) initializing.current = false;
			});
		return () => {
			cancelled = true;
			void owner?.retire().catch((error: unknown) => {
				console.error("Zero retirement failed", error);
			});
			setClient(null);
		};
	}, [userID, runtime, startupAttempt]);

	if (startupFailed && connectionFailed)
		return <ConnectionRequired onRetry={retryStartup} />;
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
				<ExportBoundaryContext.Provider value={client.exportBoundary}>
					<SyncEndpointContext.Provider value={client.endpoint}>
						{children}
					</SyncEndpointContext.Provider>
				</ExportBoundaryContext.Provider>
			</SyncTrackerContext.Provider>
		</ZeroProvider>
	);
}
