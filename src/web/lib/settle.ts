// A row observed going open -> done "settles": it stays in place for SETTLE_MS
// so an accidental check can be seen and undone, then joins the completed group.
// One shared timer restarts on every new completion, so a run of checks settles
// together and rows never shift under the pointer mid-run.
export const SETTLE_MS = 1300;

export type SettleState = {
	done: ReadonlyMap<string, boolean>;
	settling: ReadonlySet<string>;
	// Bumped only when a row starts settling; the timer restarts on it.
	epoch: number;
};

export const EMPTY_SETTLE: SettleState = {
	done: new Map(),
	settling: new Set(),
	epoch: 0,
};

// Returns `state` itself when nothing changed, so a render-phase setState on the
// result bails out instead of looping.
export function observeTasks(
	state: SettleState,
	tasks: readonly { id: string; done: boolean | null }[],
): SettleState {
	const done = new Map<string, boolean>();
	const settling = new Set(state.settling);
	let changed = tasks.length !== state.done.size;
	let added = false;
	for (const task of tasks) {
		const now = task.done ?? false;
		const before = state.done.get(task.id);
		done.set(task.id, now);
		if (before !== now) changed = true;
		// A row first seen already done (initial sync, a newly visible list) is
		// not a completion anyone watched, so it goes straight to the group.
		if (now && before === false && !settling.has(task.id)) {
			settling.add(task.id);
			added = true;
		}
		if (!now) settling.delete(task.id);
	}
	for (const id of settling) if (!done.has(id)) settling.delete(id);
	if (settling.size !== state.settling.size) changed = true;
	if (!changed) return state;
	return { done, settling, epoch: added ? state.epoch + 1 : state.epoch };
}

// Rows seen done in `prev` and open in `next`: a reopen from any path (Undo,
// a manual uncheck, another device).
export function reopenedIds(
	prev: ReadonlyMap<string, boolean>,
	next: ReadonlyMap<string, boolean>,
): string[] {
	const out: string[] = [];
	for (const [id, done] of next)
		if (!done && prev.get(id) === true) out.push(id);
	return out;
}

export function settleAll(state: SettleState): SettleState {
	return state.settling.size === 0 ? state : { ...state, settling: new Set() };
}
