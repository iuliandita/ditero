// Bridge from the global keymap to the one list surface that owns a selection.
// The command handlers live at the workspace shell; the selection state lives
// in the open list, which registers itself here while mounted.

export type SelectionCommand =
	| "toggle"
	| "extendDown"
	| "extendUp"
	| "all"
	| "clear";

type Target = {
	run: (command: SelectionCommand) => void;
	can: (command: SelectionCommand) => boolean;
};

const COMMAND_IDS: Record<string, SelectionCommand> = {
	"selection.toggle": "toggle",
	"selection.extendDown": "extendDown",
	"selection.extendUp": "extendUp",
	"selection.all": "all",
	"selection.clear": "clear",
};

let target: Target | null = null;

export function registerSelectionTarget(next: Target): () => void {
	target = next;
	return () => {
		if (target === next) target = null;
	};
}

export function selectionCommandOf(id: string): SelectionCommand | null {
	return Object.hasOwn(COMMAND_IDS, id) ? COMMAND_IDS[id] : null;
}

export function runSelectionCommand(command: SelectionCommand): void {
	target?.run(command);
}

// A registry command with no selectable list open leaves its key alone, so
// Ctrl+A and Escape keep their ordinary meaning everywhere else.
export function canRunCommand(id: string): boolean {
	const command = selectionCommandOf(id);
	if (command === null) return true;
	return target?.can(command) ?? false;
}
