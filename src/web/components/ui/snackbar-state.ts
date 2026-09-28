export const SNACKBAR_MS = 5000;

export type SnackAction = { label: string; run: () => void };
// `key` names what the snack is about (a task id), so a change to that thing
// from any path can retract a snack that no longer describes it.
export type Snack = {
	id: number;
	message: string;
	key?: string;
	action?: SnackAction;
};
export type SnackbarState = { snack: Snack | null; nextId: number };

export type SnackbarEvent =
	| { type: "show"; message: string; key?: string; action?: SnackAction }
	| { type: "dismiss"; id: number }
	| { type: "dismissKey"; key: string };

export const EMPTY_SNACKBAR: SnackbarState = { snack: null, nextId: 1 };

// One snack at a time: a newer one replaces the current outright. Dismissal is
// by id so a stale timer or a late click on the replaced snack cannot close
// its successor.
export function snackbarReducer(
	state: SnackbarState,
	event: SnackbarEvent,
): SnackbarState {
	if (event.type === "show") {
		return {
			snack: {
				id: state.nextId,
				message: event.message,
				key: event.key,
				action: event.action,
			},
			nextId: state.nextId + 1,
		};
	}
	const match =
		event.type === "dismiss"
			? state.snack?.id === event.id
			: state.snack?.key !== undefined && state.snack.key === event.key;
	return match ? { ...state, snack: null } : state;
}

// Pausable countdown for the auto-dismiss. `startedAt` null means paused.
export type Countdown = { remaining: number; startedAt: number | null };

// A snack that replaces another under a resting pointer or held focus starts
// paused: no pointerenter/focus event will arrive to pause it.
export const startCountdown = (
	ms: number,
	now: number,
	paused = false,
): Countdown => ({ remaining: ms, startedAt: paused ? null : now });

export function pauseCountdown(c: Countdown, now: number): Countdown {
	if (c.startedAt === null) return c;
	return {
		remaining: Math.max(0, c.remaining - (now - c.startedAt)),
		startedAt: null,
	};
}

export function resumeCountdown(c: Countdown, now: number): Countdown {
	return c.startedAt === null ? { ...c, startedAt: now } : c;
}
