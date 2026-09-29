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
	| { type: "retain"; ids: ReadonlySet<string> }
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
		// Rows that stopped being on screen or selectable (completed into the
		// collapsed group, deleted, moved, paused by an import) leave the
		// selection, so an action never reaches a row the user cannot see.
		// Unchanged state is returned as is, so a caller may retain every render.
		case "retain": {
			const ids = state.ids.filter((id) => event.ids.has(id));
			if (ids.length === state.ids.length) return state;
			if (ids.length === 0) return EMPTY_SELECTION;
			const anchor =
				state.anchor !== null && event.ids.has(state.anchor)
					? state.anchor
					: null;
			return {
				ids,
				anchor,
				base: state.base.filter((id) => event.ids.has(id)),
			};
		}
		case "clear":
			return EMPTY_SELECTION;
	}
}
