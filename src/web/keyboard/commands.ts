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
];
