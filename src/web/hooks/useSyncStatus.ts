import { useConnectionState } from "@rocicorp/zero/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	deriveSyncPhase,
	OFFLINE_GRACE_MS,
	SYNCING_DELAY_MS,
	type SyncPhase,
} from "../lib/sync-status.ts";
import { useSyncTracker } from "../lib/zero.tsx";

function subscribeOnline(onChange: () => void) {
	window.addEventListener("online", onChange);
	window.addEventListener("offline", onChange);
	return () => {
		window.removeEventListener("online", onChange);
		window.removeEventListener("offline", onChange);
	};
}

function subscribeVisibility(onChange: () => void) {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
}

// True once `active` has held for `delayMs`; drops back immediately.
function useHeld(active: boolean, delayMs: number): boolean {
	const [held, setHeld] = useState(false);
	useEffect(() => {
		setHeld(false);
		if (!active) return;
		const timer = window.setTimeout(() => setHeld(true), delayMs);
		return () => window.clearTimeout(timer);
	}, [active, delayMs]);
	return held;
}

export function useSyncStatus(): {
	phase: SyncPhase;
	pending: number;
	dismissRejection: () => void;
} {
	const connection = useConnectionState();
	const tracker = useSyncTracker();
	const { pending, rejected, sessionExpired } = useSyncExternalStore(
		tracker.subscribe,
		tracker.getSnapshot,
	);
	const browserOnline = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true,
	);
	const tabHidden = useSyncExternalStore(
		subscribeVisibility,
		() => document.visibilityState === "hidden",
		() => false,
	);
	const graceElapsed = useHeld(
		connection.name !== "connected",
		OFFLINE_GRACE_MS,
	);
	const pendingShown = useHeld(pending > 0, SYNCING_DELAY_MS) ? pending : 0;

	return {
		phase: deriveSyncPhase({
			connection: connection.name,
			reason: "reason" in connection ? String(connection.reason) : undefined,
			tabHidden,
			pending: pendingShown,
			rejected,
			sessionExpired,
			offlineSettled: graceElapsed || !browserOnline,
		}),
		pending: pendingShown,
		dismissRejection: tracker.dismissRejection,
	};
}
