import { keyBetween } from "../../domain/sort-key.ts";

// Fractional key for a drag-drop reorder (design 2.8): only the dragged row's
// sortKey changes, computed from its new neighbours, so a reorder is a single
// write instead of a whole-list rewrite (no sync storm). `ordered` is the
// current display order; `activeId` moves to `overId`'s slot.
export function reorderSortKey(
	ordered: { id: string; sortKey: string }[],
	activeId: string,
	overId: string,
): string | null {
	const from = ordered.findIndex((i) => i.id === activeId);
	const to = ordered.findIndex((i) => i.id === overId);
	if (from < 0 || to < 0 || from === to) return null;
	const rest = ordered.filter((i) => i.id !== activeId);
	// Moving down inserts after `over`; moving up inserts before it.
	const insertAt = rest.findIndex((i) => i.id === overId) + (to > from ? 1 : 0);
	const prev = rest[insertAt - 1] ?? null;
	const next = rest[insertAt] ?? null;
	return keyBetween(prev?.sortKey ?? null, next?.sortKey ?? null);
}
