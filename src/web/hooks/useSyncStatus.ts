import { useConnectionState } from "@rocicorp/zero/react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
	deriveSyncPhase,
	OFFLINE_GRACE_MS,
	type SyncPhase,
} from "../lib/sync-status.ts";
import { usePendingMutations } from "../lib/zero.tsx";

function subscribeOnline(onChange: () => void) {
	window.addEventListener("online", onChange);
	window.addEventListener("offline", onChange);
	return () => {
		window.removeEventListener("online", onChange);
		window.removeEventListener("offline", onChange);
	};
}

export function useSyncStatus(): {
	phase: SyncPhase;
	pending: number;
	dismissRejection: () => void;
} {
	const connection = useConnectionState().name;
	const tracker = usePendingMutations();
	const { pending, rejected } = useSyncExternalStore(
		tracker.subscribe,
		tracker.getSnapshot,
	);
	const browserOnline = useSyncExternalStore(
		subscribeOnline,
		() => navigator.onLine,
		() => true,
	);
	const [graceElapsed, setGraceElapsed] = useState(false);
	const connected = connection === "connected";

	useEffect(() => {
		setGraceElapsed(false);
		if (connected) return;
		const timer = window.setTimeout(
			() => setGraceElapsed(true),
			OFFLINE_GRACE_MS,
		);
		return () => window.clearTimeout(timer);
	}, [connected]);

	return {
		phase: deriveSyncPhase({
			connection,
			pending,
			rejected,
			offlineSettled: graceElapsed || !browserOnline,
		}),
		pending,
		dismissRejection: tracker.dismissRejection,
	};
}
