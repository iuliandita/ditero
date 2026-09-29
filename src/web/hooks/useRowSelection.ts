import {
	useEffect,
	useLayoutEffect,
	useReducer,
	useRef,
	useState,
} from "react";
import type { RowSelection } from "../components/list/TaskRow.tsx";
import {
	registerSelectionTarget,
	type SelectionCommand,
} from "../keyboard/selection-commands.ts";
import { EMPTY_SELECTION, selectionReducer } from "../lib/selection.ts";

// Surfaces that own Escape while they are up; clearing the selection under
// them would spend one keypress on two things.
const ESCAPE_OWNERS =
	'[role="dialog"], [role="alertdialog"], [role="menu"], [data-task-panel]';

const ROW_NAV = "[data-kbd-nav][data-task-id]";

// Bulk selection over the task rows rendered inside `rootRef`, shared by the
// list surface and the saved-view list. The DOM is the source of on-screen
// order: grouping, sinking and the collapsed completed group are all whatever
// the user sees. A row counts only while it is rendered and selectable.
export function useRowSelection({
	enabled,
	resetKey,
	isSelectable,
}: {
	// No write role (or no surface): no selection at all, and any held one clears.
	enabled: boolean;
	// A selection belongs to the list or view it was made in.
	resetKey: string;
	isSelectable: (taskId: string) => boolean;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const [state, dispatch] = useReducer(selectionReducer, EMPTY_SELECTION);
	const [lastReset, setLastReset] = useState(resetKey);
	if (lastReset !== resetKey) {
		setLastReset(resetKey);
		dispatch({ type: "clear" });
	}

	function rowOrder(): string[] {
		const root = rootRef.current;
		if (!root) return [];
		// A view grouped by assignee or label shows a task once per group; it is
		// still one task to select.
		const ids = Array.from(root.querySelectorAll<HTMLElement>(ROW_NAV)).map(
			(el) => el.dataset.taskId ?? "",
		);
		return [...new Set(ids)].filter((id) => id !== "" && isSelectable(id));
	}
	function focusedRowId(): string | null {
		const row = document.activeElement?.closest<HTMLElement>("[data-kbd-row]");
		if (!row || !rootRef.current?.contains(row)) return null;
		const id = row.querySelector<HTMLElement>(ROW_NAV)?.dataset.taskId ?? null;
		return id && isSelectable(id) ? id : null;
	}
	function focusRow(id: string) {
		rootRef.current
			?.querySelector<HTMLElement>(
				`${ROW_NAV}[data-task-id="${CSS.escape(id)}"]`,
			)
			?.focus();
	}
	const focusInRoot = () =>
		rootRef.current?.contains(document.activeElement) ?? false;

	// After every commit, drop whatever stopped being on screen or selectable.
	// The reducer returns the same state when nothing changed, so this settles.
	useLayoutEffect(() => {
		if (state.ids.length === 0) return;
		if (!enabled) dispatch({ type: "clear" });
		else dispatch({ type: "retain", ids: new Set(rowOrder()) });
	});
	// Rows also leave without this surface re-rendering: a completed row
	// settles into the collapsed group inside the list's own state.
	const retainRef = useRef(() => {});
	retainRef.current = () =>
		dispatch({ type: "retain", ids: new Set(rowOrder()) });
	const holding = enabled && state.ids.length > 0;
	useEffect(() => {
		const root = rootRef.current;
		if (!holding || !root) return;
		const observer = new MutationObserver(() => retainRef.current());
		observer.observe(root, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [holding]);

	const count = enabled ? state.ids.length : 0;

	// The keymap reaches this surface through the selection registry; the
	// callbacks are refreshed every render so they read current state.
	const command = useRef<{
		run: (c: SelectionCommand) => void;
		can: (c: SelectionCommand) => boolean;
	}>({ run: () => {}, can: () => false });
	command.current = {
		can: (c) => {
			if (c === "clear")
				return count > 0 && document.querySelector(ESCAPE_OWNERS) === null;
			if (c === "toggle") return focusedRowId() !== null;
			// Select-all and range keys only while the list holds focus, so
			// Ctrl/Cmd+A stays the page's (or the task panel's) everywhere else.
			return focusInRoot() && rowOrder().length > 0;
		},
		run: (c) => {
			if (c === "clear") {
				dispatch({ type: "clear" });
				return;
			}
			const order = rowOrder();
			if (c === "all") {
				dispatch({ type: "all", order });
				return;
			}
			const current = focusedRowId();
			if (c === "toggle") {
				if (current) dispatch({ type: "toggle", id: current });
				return;
			}
			const step = c === "extendDown" ? 1 : -1;
			const from = current ?? (step > 0 ? order[0] : order[order.length - 1]);
			if (!from) return;
			// The focused row joins first, so a range always includes where the
			// user started from.
			if (state.anchor === null) dispatch({ type: "extend", order, to: from });
			const next = current ? order[order.indexOf(current) + step] : from;
			if (!next) return;
			dispatch({ type: "extend", order, to: next });
			focusRow(next);
		},
	};
	useEffect(() => {
		if (!enabled) return;
		return registerSelectionTarget({
			run: (c) => command.current.run(c),
			can: (c) => command.current.can(c),
		});
	}, [enabled]);

	const selected = new Set(enabled ? state.ids : []);

	return {
		rootRef,
		count,
		// Selected ids in on-screen order, so a bulk move keeps what the user saw.
		ordered: (): string[] => rowOrder().filter((id) => selected.has(id)),
		clear: () => dispatch({ type: "clear" }),
		// After an action that ends the selection, keep keyboard focus in the list
		// without scrolling the viewport to its first row.
		finish: () => {
			dispatch({ type: "clear" });
			requestAnimationFrame(() =>
				rootRef.current
					?.querySelector<HTMLElement>(ROW_NAV)
					?.focus({ preventScroll: true }),
			);
		},
		rowFor: (
			taskId: string,
			blockedReason?: string,
		): RowSelection | undefined => {
			if (!enabled) return undefined;
			const selectable = isSelectable(taskId);
			return {
				selected: selectable && selected.has(taskId),
				active: count > 0,
				selectable,
				blockedReason: selectable ? undefined : blockedReason,
				toggle: () => {
					if (selectable) dispatch({ type: "toggle", id: taskId });
				},
				extend: () => {
					if (selectable)
						dispatch({ type: "extend", order: rowOrder(), to: taskId });
				},
			};
		},
	};
}
