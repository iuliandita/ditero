import type { ListKind } from "../../domain/icon-map.ts";

// Round is a task someone does; square is an item ticked off a list. Shopping
// and checklist rows read as items, so they keep the square box.
export function checkShapeFor(kind: ListKind): "round" | "square" {
	return kind === "shopping" || kind === "checklist" ? "square" : "round";
}

// Only a round task box carries its priority tone; an item box stays neutral
// (the row's flag still shows priority where the kind has one).
export function checkToneFor(
	kind: ListKind,
	priority: number | null | undefined,
): number | null {
	return checkShapeFor(kind) === "round" ? (priority ?? null) : null;
}
