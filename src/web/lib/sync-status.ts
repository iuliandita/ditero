import { mutationResultFailure } from "./run-mutation.ts";

// Zero refuses every mutation on the client once it has spent this long trying
// to reconnect (its own default is one minute). Connecting and disconnected
// retry on the same five-second loop, so a longer window costs no extra
// traffic; it only keeps accepting local edits, which persist in IndexedDB and
// replay on reconnect. Finite on purpose: a week covers a trip or a long
// outage, and stays far below the 2^31-1 ms ceiling a setTimeout-based
// implementation would overflow on.
export const OFFLINE_EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Reconnects shorter than this (a server restart, a network hand-off) do not
// flash an offline state.
export const OFFLINE_GRACE_MS = 3000;

export type ConnectionName =
	| "connecting"
	| "connected"
	| "disconnected"
	| "needs-auth"
	| "error"
	| "closed";

// synced: nothing waiting. syncing: edits on their way, or (re)connecting
// briefly. offline: the server is unreachable but edits are still accepted.
// stopped: Zero refuses new edits. rejected: the server refused a write.
export type SyncPhase =
	| "synced"
	| "syncing"
	| "offline"
	| "stopped"
	| "rejected";

export function deriveSyncPhase({
	connection,
	pending,
	rejected,
	offlineSettled,
}: {
	connection: ConnectionName;
	pending: number;
	rejected: boolean;
	// The browser reports no network, or a reconnect has outlasted the grace.
	offlineSettled: boolean;
}): SyncPhase {
	if (
		connection === "disconnected" ||
		connection === "error" ||
		connection === "closed"
	)
		return "stopped";
	if (rejected) return "rejected";
	if (connection !== "connected") return offlineSettled ? "offline" : "syncing";
	return pending > 0 ? "syncing" : "synced";
}

type TrackedMutation = { client: Promise<unknown>; server: Promise<unknown> };

export type PendingSnapshot = { pending: number; rejected: boolean };

// Counts writes applied on this device that the server has not confirmed.
// A write whose `.client` failed never applied, so it is dropped. A `.server`
// settling with a "zero" error means the connection dropped (Zero settles
// every outstanding write then) while the write stays queued in IndexedDB; it
// stays counted until the next connect, when Zero pushes the queue.
export function createPendingMutations() {
	let inFlight = 0;
	let awaitingReconnect = 0;
	let rejected = false;
	let snapshot: PendingSnapshot = { pending: 0, rejected: false };
	const listeners = new Set<() => void>();

	function publish() {
		const next = { pending: inFlight + awaitingReconnect, rejected };
		if (
			next.pending === snapshot.pending &&
			next.rejected === snapshot.rejected
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
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => snapshot,
	};
}

export type PendingMutations = ReturnType<typeof createPendingMutations>;

// Every write in the app goes through `zero.mutate(request)`, so wrapping it
// once where the client is built counts all of them, including call sites
// added later, without touching each one.
export function trackMutations<Z extends { mutate: unknown }>(
	zero: Z,
	pending: PendingMutations,
): void {
	const mutate = zero.mutate as (...args: unknown[]) => TrackedMutation;
	const tracked = (...args: unknown[]) => {
		const result = mutate(...args);
		pending.track(result);
		return result;
	};
	Object.assign(tracked, mutate);
	Object.defineProperty(zero, "mutate", { value: tracked });
}
