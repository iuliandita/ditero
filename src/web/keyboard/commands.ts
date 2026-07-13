import type { CommandDef } from "../../domain/keymap.ts";

// Pure command registry: ids/labels/bindings/context, no handlers. Handlers are
// injected at mount via CommandProvider so this stays testable. Task 9 EXTENDS
// this array with movement + vim bindings; keep every id unique and every
// command's `context` set (findConflicts guards the default profile in the test).
export const COMMANDS: CommandDef[] = [
	{
		id: "palette.open",
		category: "general",
		label: "Command palette",
		bindings: { default: [["Meta", "k"]] },
		context: "global",
	},
	{
		id: "task.create",
		category: "task",
		label: "New task",
		bindings: { default: [["c"]] },
		context: "global",
	},
	{
		id: "search.open",
		category: "general",
		label: "Search",
		bindings: { default: [["/"]] },
		context: "global",
	},
	{
		id: "view.new",
		category: "view",
		label: "New view",
		bindings: { default: [] },
		context: "global",
	},
	{
		id: "nav.today",
		category: "nav",
		label: "Go to Today",
		bindings: { default: [["g", "t"]] },
		context: "global",
	},
	{
		id: "help.cheatSheet",
		category: "help",
		label: "Keyboard shortcuts",
		bindings: { default: [["?"]] },
		context: "global",
	},
	{
		id: "settings.open",
		category: "general",
		label: "Open settings",
		bindings: { default: [["g", "s"]] },
		context: "global",
	},
	// Movement is Linear-style single-key in BOTH profiles (design 2.18); vim only
	// diverges on the edit/delete subset (dd to delete). j/k/o/x stay as defaults.
	{
		id: "nav.down",
		category: "nav",
		label: "Move down",
		bindings: { default: [["j"]] },
		context: "global",
	},
	{
		id: "nav.up",
		category: "nav",
		label: "Move up",
		bindings: { default: [["k"]] },
		context: "global",
	},
	{
		id: "nav.open",
		category: "nav",
		label: "Open focused",
		bindings: { default: [["o"]] },
		context: "global",
	},
	{
		id: "task.toggleDone",
		category: "task",
		label: "Toggle done",
		bindings: { default: [["x"]] },
		context: "global",
	},
	{
		id: "task.delete",
		category: "task",
		label: "Delete focused",
		bindings: { default: [["Backspace"]], vim: [["d", "d"]] },
		context: "global",
	},
];
