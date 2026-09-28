import type { ListKind } from "../../domain/icon-map.ts";

// Round is a task someone does; square is an item ticked off a list. Shopping
// and checklist rows read as items, so they keep the square box.
export function checkShapeFor(kind: ListKind): "round" | "square" {
	return kind === "shopping" || kind === "checklist" ? "square" : "round";
}
