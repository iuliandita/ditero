import type { ListKind } from "../../domain/icon-map.ts";
import { m } from "../../paraglide/messages.js";

type AddCopy = { placeholder: () => string; action: () => string };

// Thunks: resolving `m` at module scope would freeze the import-time locale.
const TASK: AddCopy = {
	placeholder: m.list_add_task_placeholder,
	action: m.list_add_task,
};
const ITEM: AddCopy = {
	placeholder: m.list_add_item_placeholder,
	action: m.list_add_item,
};
const HABIT: AddCopy = {
	placeholder: m.list_add_habit_placeholder,
	action: m.list_add_habit,
};

// What the add field calls a new row: shopping and checklist rows are items
// ticked off, habits are tracked, tasks and projects hold tasks.
export function addCopyFor(kind: ListKind | null | undefined): AddCopy {
	switch (kind) {
		case "shopping":
		case "checklist":
			return ITEM;
		case "habits":
			return HABIT;
		default:
			return TASK;
	}
}
