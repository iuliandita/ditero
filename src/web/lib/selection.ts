// Bulk selection over a list's rows. `anchor` is where a range starts (the last
// row toggled) and `base` the selection before the range began, so extending
// back toward the anchor shrinks the range instead of only ever growing it.

export type Selection = {
	ids: readonly string[];
	anchor: string | null;
	base: readonly string[];
};

export type SelectionEvent =
	| { type: "toggle"; id: string }
	| { type: "extend"; order: readonly string[]; to: string }
	| { type: "all"; order: readonly string[] }
	| { type: "clear" };

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null, base: [] };

export function selectionReducer(
	state: Selection,
	event: SelectionEvent,
): Selection {
	switch (event.type) {
		case "toggle": {
			const ids = state.ids.includes(event.id)
				? state.ids.filter((id) => id !== event.id)
				: [...state.ids, event.id];
			return ids.length === 0
				? EMPTY_SELECTION
				: { ids, anchor: event.id, base: ids };
		}
		case "extend": {
			const to = event.order.indexOf(event.to);
			if (to < 0) return state;
			const from =
				state.anchor === null ? -1 : event.order.indexOf(state.anchor);
			if (from < 0) {
				const ids = state.ids.includes(event.to)
					? state.ids
					: [...state.ids, event.to];
				return { ids, anchor: event.to, base: ids };
			}
			const range = event.order.slice(
				Math.min(from, to),
				Math.max(from, to) + 1,
			);
			return {
				...state,
				ids: [...new Set([...state.base, ...range])],
			};
		}
		case "all":
			return event.order.length === 0
				? EMPTY_SELECTION
				: {
						ids: [...event.order],
						anchor: state.anchor ?? event.order[0],
						base: [...event.order],
					};
		case "clear":
			return EMPTY_SELECTION;
	}
}

// Rows that left the list (deleted, moved, synced away) drop out of the
// selection without an event: the bar never counts what is not there.
export function liveSelection(
	state: Selection,
	present: ReadonlySet<string>,
): string[] {
	return state.ids.filter((id) => present.has(id));
}
