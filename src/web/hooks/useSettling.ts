import { type RefObject, useEffect, useState } from "react";
import {
	EMPTY_SETTLE,
	observeTasks,
	SETTLE_MS,
	settleAll,
} from "../lib/settle.ts";

// Keyboard users complete with `x` on a focused row; when that row leaves for
// the collapsed group its focus would drop to <body>. Hand it to the nearest
// row that stays, preferring the next one, like a list after a delete.
function handOffFocus(root: HTMLElement | null) {
	const active = document.activeElement;
	if (!root || !active?.closest("[data-settling]") || !root.contains(active))
		return;
	const staying = Array.from(
		root.querySelectorAll<HTMLElement>("[data-kbd-nav]"),
	).filter((el) => !el.closest("[data-settling]"));
	const next = staying.find(
		(el) =>
			active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING,
	);
	(next ?? staying.at(-1))?.focus();
}

export function useSettling(
	tasks: readonly { id: string; done: boolean | null }[],
	rootRef: RefObject<HTMLElement | null>,
): ReadonlySet<string> {
	const [state, setState] = useState(() => observeTasks(EMPTY_SETTLE, tasks));
	// Derived during render, not in an effect: a just-checked row must never
	// paint once in the completed group before being pulled back into place.
	const current = observeTasks(state, tasks);
	if (current !== state) setState(current);

	const pending = current.settling.size > 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: epoch restarts the shared timer on each new completion.
	useEffect(() => {
		if (!pending) return;
		const timer = setTimeout(() => {
			handOffFocus(rootRef.current);
			setState(settleAll);
		}, SETTLE_MS);
		return () => clearTimeout(timer);
	}, [pending, current.epoch, rootRef]);

	return current.settling;
}
