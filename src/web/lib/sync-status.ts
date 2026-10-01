import { mutationResultFailure } from "./run-mutation.ts";

// Zero refuses every mutation on the client once it has spent this long trying
// to reconnect (its own default is one minute). Connecting and disconnected
// retry on the same five-second loop, so a longer window costs no extra
// traffic; it only keeps accepting local edits, which persist in IndexedDB and
// replay on reconnect. A week matches the default Better Auth session, after
// which the sync state asks the user to sign in again. Finite on purpose: it
// stays far below the 2^31-1 ms ceiling a setTimeout-based implementation
// would overflow on.
export const OFFLINE_EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Reconnects shorter than this (a server restart, a network hand-off) do not
// flash an offline state.
export const OFFLINE_GRACE_MS = 3000;

// Edits confirmed faster than this never show the syncing state, so ordinary
// online use does not flicker.
export const SYNCING_DELAY_MS = 500;

// Zero disconnects a tab hidden for five minutes and reconnects as soon as it
// is visible again; that pause refuses nothing the user could type. The public
// connection state only carries the reason's message, so it is matched here
// and pinned against the installed Zero by sync-status.test.ts.
export const ZERO_HIDDEN_REASON = "Connection closed because tab was hidden";

export type ConnectionName =
	| "connecting"
	| "connected"
	| "disconnected"
	| "needs-auth"
	| "error"
	| "closed";

// synced: nothing waiting. syncing: edits on their way, or (re)connecting
// briefly. offline: the server is unreachable but edits are still accepted.
// reauth: the session expired, edits wait for a new sign-in. stopped: Zero
// refuses new edits. rejected: the server refused a write.
export type SyncPhase =
	| "synced"
	| "syncing"
	| "offline"
	| "reauth"
	| "auth-rejected"
	| "stopped"
	| "rejected";

export function deriveSyncPhase({
	connection,
	reason,
	tabHidden,
	pending,
	rejected,
	sessionExpired,
	authRejected,
	offlineSettled,
}: {
	connection: ConnectionName;
	reason?: string;
	tabHidden: boolean;
	pending: number;
	rejected: boolean;
	sessionExpired: boolean;
	authRejected: boolean;
	// The browser reports no network, or a reconnect has outlasted the grace.
	offlineSettled: boolean;
}): SyncPhase {
	const pausedWhileHidden =
		connection === "disconnected" &&
		(tabHidden || reason === ZERO_HIDDEN_REASON);
	if (
		(connection === "disconnected" && !pausedWhileHidden) ||
		connection === "error" ||
		connection === "closed"
	)
		return "stopped";
	if (connection === "needs-auth" && sessionExpired) return "reauth";
	if (rejected) return "rejected";
	if (connection !== "connected" && authRejected) return "auth-rejected";
	if (connection !== "connected") return offlineSettled ? "offline" : "syncing";
	return pending > 0 ? "syncing" : "synced";
}

type TrackedMutation = { client: Promise<unknown>; server: Promise<unknown> };

export type SyncSnapshot = {
	pending: number;
	rejected: boolean;
	sessionExpired: boolean;
	authRejected: boolean;
};

// Counts writes made in this tab that the server has not confirmed. A write
// whose `.client` failed never applied, so it is dropped. A `.server` settling
// with a "zero" error means the connection dropped (Zero settles every
// outstanding write then) while the write stays queued in IndexedDB; it stays
// counted until the next connect, when Zero pushes the queue. Zero 1.9 has no
// public count of its queue, so writes queued before a reload are not counted
// here; they still replay.
export function createSyncTracker() {
	let inFlight = 0;
	let awaitingReconnect = 0;
	let rejected = false;
	let sessionExpired = false;
	let authRejected = false;
	let snapshot: SyncSnapshot = {
		pending: 0,
		rejected: false,
		sessionExpired: false,
		authRejected: false,
	};
	const listeners = new Set<() => void>();

	function publish() {
		const next = {
			pending: inFlight + awaitingReconnect,
			rejected,
			sessionExpired,
			authRejected,
		};
		if (
			next.pending === snapshot.pending &&
			next.rejected === snapshot.rejected &&
			next.sessionExpired === snapshot.sessionExpired &&
			next.authRejected === snapshot.authRejected
		)
			return;
		snapshot = next;
		for (const listener of listeners) listener();
	}

	async function settle(mutation: TrackedMutation) {
		if (mutationResultFailure(await mutation.client) !== null) {
			inFlight--;
			publish();
			return;
		}
		const failure = mutationResultFailure(await mutation.server);
		inFlight--;
		if (failure?.kind === "zero") awaitingReconnect++;
		else if (failure?.kind === "app") rejected = true;
		publish();
	}

	return {
		track(mutation: TrackedMutation) {
			inFlight++;
			publish();
			void settle(mutation);
		},
		connected() {
			awaitingReconnect = 0;
			publish();
		},
		dismissRejection() {
			rejected = false;
			publish();
		},
		setAuthRejected(value: boolean) {
			authRejected = value;
			publish();
		},
		setSessionExpired(expired: boolean) {
			sessionExpired = expired;
			publish();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => snapshot,
	};
}

export type SyncTracker = ReturnType<typeof createSyncTracker>;

// Every write in the app goes through `zero.mutate(request)`, so wrapping it
// once where the client is built counts all of them, including call sites
// added later, without touching each one.
export function trackMutations<Z extends { mutate: unknown }>(
	zero: Z,
	tracker: SyncTracker,
): void {
	const mutate = zero.mutate as (...args: unknown[]) => TrackedMutation;
	const tracked = (...args: unknown[]) => {
		const result = mutate(...args);
		tracker.track(result);
		return result;
	};
	Object.assign(tracked, mutate);
	Object.defineProperty(zero, "mutate", { value: tracked });
}
