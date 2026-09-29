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
export type SnackbarState = {
	snack: Snack | null;
	nextId: number;
	// Failure notices waiting for an unrelated snack to finish.
	queue: { message: string; key: string }[];
	// Keys the user already took back (reopened, moved back): a late failure
	// for them describes a state nobody is looking at any more.
	retracted: string[];
};

export type SnackbarEvent =
	| { type: "show"; message: string; key?: string; action?: SnackAction }
	| { type: "fail"; message: string; key: string }
	| { type: "dismiss"; id: number }
	| { type: "dismissKey"; key: string };

export const EMPTY_SNACKBAR: SnackbarState = {
	snack: null,
	nextId: 1,
	queue: [],
	retracted: [],
};

const RETRACTED_MAX = 50;

// The next queued failure takes the freed slot, if any.
function advance(state: SnackbarState): SnackbarState {
	const [next, ...rest] = state.queue;
	if (!next) return { ...state, snack: null };
	return {
		...state,
		snack: { id: state.nextId, message: next.message, key: next.key },
		nextId: state.nextId + 1,
		queue: rest,
	};
}

// One snack at a time: a newer confirmation replaces the current outright.
// A failure only replaces the confirmation it contradicts (same key) or an
// empty slot; beside an unrelated snack it waits its turn, so it never takes
// someone else's Undo away. Dismissal is by id so a stale timer or a late
// click on the replaced snack cannot close its successor.
export function snackbarReducer(
	state: SnackbarState,
	event: SnackbarEvent,
): SnackbarState {
	if (event.type === "show") {
		return {
			...state,
			snack: {
				id: state.nextId,
				message: event.message,
				key: event.key,
				action: event.action,
			},
			nextId: state.nextId + 1,
			retracted: state.retracted.filter((k) => k !== event.key),
		};
	}
	if (event.type === "fail") {
		if (state.retracted.includes(event.key)) return state;
		if (state.snack == null || state.snack.key === event.key)
			return {
				...state,
				snack: { id: state.nextId, message: event.message, key: event.key },
				nextId: state.nextId + 1,
			};
		return {
			...state,
			queue: [
				...state.queue.filter((q) => q.key !== event.key),
				{ message: event.message, key: event.key },
			],
		};
	}
	if (event.type === "dismissKey") {
		const cleared = {
			...state,
			queue: state.queue.filter((q) => q.key !== event.key),
			retracted: [
				...state.retracted.filter((k) => k !== event.key),
				event.key,
			].slice(-RETRACTED_MAX),
		};
		return state.snack?.key === event.key ? advance(cleared) : cleared;
	}
	return state.snack?.id === event.id ? advance(state) : state;
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
