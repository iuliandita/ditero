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
		id: "nav.dashboard",
		category: "nav",
		label: "Go to dashboard",
		bindings: { default: [["g", "d"]] },
		context: "global",
	},
	{
		id: "dashboard.new",
		category: "view",
		label: "New dashboard",
		bindings: { default: [] },
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
	// Movement is Linear-style single-key in BOTH profiles (design 2.18): j/k/o/x
	// are the defaults for move/open/toggle.
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
	// task.delete (Backspace / vim d d) is deferred until a task-delete UI exists
	// to bind [data-kbd-action="delete"] to; advertising it with no target would be
	// a dead binding.
];
