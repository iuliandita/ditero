import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
	createVoiceCapture,
	type VoiceCapture,
	type VoiceState,
} from "../../../domain/voice-capture.ts";
import { createBrowserVoiceEngine } from "../../lib/speech-recognition.ts";

// Everything the controller's results are only valid for. Any change cancels
// the session (the controller is disposed and a new one is bound).
export type VoiceIdentity = {
	open: boolean;
	accountId: string;
	native: boolean;
	currentListId: string | null;
	targetListId: string | null;
	workspaceId: string;
	locale: string;
};

type Snapshot = {
	/** Identity key the state belongs to; null when no controller is bound. */
	key: string | null;
	state: VoiceState | null;
	/** True while a user action (not the open-time probe) owns `checking`. */
	user: boolean;
};

const EMPTY: Snapshot = { key: null, state: null, user: false };

function createVoiceStore() {
	let snapshot = EMPTY;
	let controller: VoiceCapture | null = null;
	let key: string | null = null;
	let user = false;
	let off = () => {};
	const listeners = new Set<() => void>();

	const publish = () => {
		const state = controller?.getState() ?? null;
		if (
			!state ||
			state.phase === "idle" ||
			state.phase === "error" ||
			state.phase === "unsupported"
		) {
			user = false;
		}
		snapshot = { key, state, user };
		for (const listener of [...listeners]) listener();
	};

	const release = () => {
		off();
		off = () => {};
		controller?.dispose();
		controller = null;
		key = null;
		user = false;
	};

	return {
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot: () => snapshot,
		bind(identity: VoiceIdentity, nextKey: string) {
			release();
			if (identity.open) {
				const created = createVoiceCapture({
					engine: createBrowserVoiceEngine(),
					native: identity.native,
					locale: identity.locale,
				});
				controller = created;
				key = nextKey;
				off = created.subscribe(publish);
				publish();
				// Capability check only: it never listens. A later mic click can
				// then start synchronously inside its gesture.
				created.probe();
			} else publish();
		},
		unbind() {
			release();
			publish();
		},
		// Retry (error, or idle after a cancelled probe): a user action re-probes;
		// the mic click that follows starts.
		reprobe() {
			const state = controller?.getState();
			if (
				state?.phase === "error" ||
				(state?.phase === "idle" && !state.ready)
			) {
				user = true;
			}
			controller?.probe();
		},
		// Marked before the controller runs so its synchronous publish carries it.
		start() {
			if (controller?.getState().phase === "idle") user = true;
			controller?.start();
		},
		stop: () => controller?.stop(),
		cancel: () => controller?.cancel(),
		invalidate: () => controller?.invalidate("page"),
		accept(boundKey: string, draft: string, index: number): string | null {
			if (!controller || boundKey !== key) return null;
			return controller.accept(draft, index);
		},
	};
}

const isActive = (snapshot: Snapshot) => {
	const phase = snapshot.state?.phase;
	return (
		phase === "listening" ||
		phase === "stopping" ||
		phase === "review" ||
		phase === "checking"
	);
};

// Submit is refused while a voice session is live. The automatic open-time
// capability probe is not one: typed Add/Enter stay usable while it is pending.
const isBlocking = (snapshot: Snapshot) => {
	const phase = snapshot.state?.phase;
	return (
		phase === "listening" ||
		phase === "stopping" ||
		phase === "review" ||
		(phase === "checking" && snapshot.user)
	);
};

export type VoiceView = {
	/** Null before a controller is bound for the CURRENT identity. */
	state: VoiceState | null;
	/** Submit must be refused: checking (user only), listening, stopping, review. */
	blocking: boolean;
	/** Read fresh at event time, not from the render closure. */
	blockedNow(): boolean;
	/** Cancels active voice and returns true; false when nothing was active. */
	cancelIfActive(): boolean;
	start(): void;
	stop(): void;
	cancel(): void;
	retry(): void;
	retryAfterReview(): void;
	accept(draft: string, index: number): string | null;
};

export function useVoiceCapture(identity: VoiceIdentity): VoiceView {
	const [store] = useState(createVoiceStore);
	const {
		open,
		accountId,
		native,
		currentListId,
		targetListId,
		workspaceId,
		locale,
	} = identity;
	const stable = useMemo<VoiceIdentity>(
		() => ({
			open,
			accountId,
			native,
			currentListId,
			targetListId,
			workspaceId,
			locale,
		}),
		[open, accountId, native, currentListId, targetListId, workspaceId, locale],
	);
	const key = useMemo(() => JSON.stringify(stable), [stable]);
	const snapshot = useSyncExternalStore(
		store.subscribe,
		store.getSnapshot,
		store.getSnapshot,
	);

	// Bound in an effect so render stays pure. Between a render with a new
	// identity and this effect, `snapshot.key !== key` and the old session is
	// treated as absent: nothing is shown and accept() is refused.
	useEffect(() => {
		store.bind(stable, key);
		return () => store.unbind();
	}, [store, stable, key]);

	useEffect(() => {
		const onHide = () => store.invalidate();
		window.addEventListener("pagehide", onHide);
		return () => window.removeEventListener("pagehide", onHide);
	}, [store]);

	const current = snapshot.key === key ? snapshot : EMPTY;
	const fresh = () => {
		const s = store.getSnapshot();
		return s.key === key ? s : EMPTY;
	};

	return {
		state: current.state,
		blocking: isBlocking(current),
		blockedNow: () => isBlocking(fresh()),
		cancelIfActive() {
			if (!isActive(fresh())) return false;
			store.cancel();
			return true;
		},
		start: () => store.start(),
		stop: () => store.stop(),
		cancel: () => store.cancel(),
		retry: () => store.reprobe(),
		// Review keeps `ready`, so this cancel + start stays in the gesture.
		retryAfterReview() {
			store.cancel();
			store.start();
		},
		accept: (draft, index) => store.accept(key, draft, index),
	};
}
