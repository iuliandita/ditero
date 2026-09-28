import {
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import {
	EMPTY_SETTLE,
	observeTasks,
	reopenedIds,
	SETTLE_MS,
	settleAll,
} from "../lib/settle.ts";

// Keyboard users complete with `x` on a focused row; when that row leaves for
// the collapsed group its focus would drop to <body>. Hand it to the nearest
// row that stays, preferring the next one, like a list after a delete. Returns
// false when focus was in a settling row but no row stays, so the caller can
// fall back once the completed group has rendered.
function handOffFocus(root: HTMLElement | null): boolean {
	const active = document.activeElement;
	if (!root || !active?.closest("[data-settling]") || !root.contains(active))
		return true;
	const staying = Array.from(
		root.querySelectorAll<HTMLElement>("[data-kbd-nav]"),
	).filter((el) => !el.closest("[data-settling]"));
	const next = staying.find(
		(el) =>
			active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
	);
	const target = next ?? staying.at(-1);
	target?.focus();
	return target !== undefined;
}

export function useSettling(
	tasks: readonly { id: string; done: boolean | null }[],
	rootRef: RefObject<HTMLElement | null>,
	onReopen?: (id: string) => void,
): ReadonlySet<string> {
	const [state, setState] = useState(() => observeTasks(EMPTY_SETTLE, tasks));
	// Derived during render, not in an effect: a just-checked row must never
	// paint once in the completed group before being pulled back into place.
	const current = observeTasks(state, tasks);
	if (current !== state) setState(current);

	const lastDone = useRef(current.done);
	useEffect(() => {
		const reopened = reopenedIds(lastDone.current, current.done);
		lastDone.current = current.done;
		for (const id of reopened) onReopen?.(id);
	}, [current.done, onReopen]);

	// The last open row settled with focus in it: the only control left in the
	// list is the completed group's disclosure, which exists only after commit.
	const focusGroup = useRef(false);
	useLayoutEffect(() => {
		if (!focusGroup.current || current.settling.size > 0) return;
		focusGroup.current = false;
		rootRef.current
			?.querySelector<HTMLElement>('[data-testid="completed-section"]')
			?.focus();
	});

	const pending = current.settling.size > 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: epoch restarts the shared timer on each new completion.
	useEffect(() => {
		if (!pending) return;
		const timer = setTimeout(() => {
			focusGroup.current = !handOffFocus(rootRef.current);
			setState(settleAll);
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	}, [pending, current.epoch, rootRef]);

	return current.settling;
}
