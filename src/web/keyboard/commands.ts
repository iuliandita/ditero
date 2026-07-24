import type { CommandDef } from "../../domain/keymap.ts";
import { m } from "../../paraglide/messages.js";

// Pure command registry: ids/labels/bindings/context, no handlers. Handlers are
// injected at mount via CommandProvider so this stays testable. Task 9 EXTENDS
// this array with movement + vim bindings; keep every id unique and every
// command's `context` set (findConflicts guards the default profile in the test).
// `label` is a getter: this array is module-level, so resolving the message
// eagerly would freeze it at the import-time locale.
export const COMMANDS: CommandDef[] = [
	{
		id: "palette.open",
		category: "general",
		get label() {
			return m.command_palette_open();
		},
		bindings: { default: [["Meta", "k"]] },
		context: "global",
	},
	{
		id: "task.create",
		category: "task",
		get label() {
			return m.command_task_create();
		},
		bindings: { default: [["c"]] },
		context: "global",
	},
	{
		id: "search.open",
		category: "general",
		get label() {
			return m.command_search_open();
		},
		bindings: { default: [["/"]] },
		context: "global",
	},
	{
		id: "view.new",
		category: "view",
		get label() {
			return m.action_new_view();
		},
		bindings: { default: [] },
		context: "global",
	},
	{
		id: "nav.today",
		category: "nav",
		get label() {
			return m.command_nav_today();
		},
		bindings: { default: [["g", "t"]] },
		context: "global",
	},
	{
		id: "nav.dashboard",
		category: "nav",
		get label() {
			return m.command_nav_dashboard();
		},
		bindings: { default: [["g", "d"]] },
		context: "global",
	},
	{
		id: "dashboard.new",
		category: "view",
		get label() {
			return m.action_new_dashboard();
		},
		bindings: { default: [] },
		context: "global",
	},
	{
		id: "help.cheatSheet",
		category: "help",
		get label() {
			return m.command_help_cheat_sheet();
		},
		bindings: { default: [["?"]] },
		context: "global",
	},
	{
		id: "settings.open",
		category: "general",
		get label() {
			return m.command_settings_open();
		},
		bindings: { default: [["g", "s"]] },
		context: "global",
	},
	// Movement is Linear-style single-key in BOTH profiles (design 2.18): j/k/o/x
	// are the defaults for move/open/toggle.
	{
		id: "nav.down",
		category: "nav",
		get label() {
			return m.command_nav_down();
		},
		bindings: { default: [["j"]] },
		context: "global",
	},
	{
		id: "nav.up",
		category: "nav",
		get label() {
			return m.command_nav_up();
		},
		bindings: { default: [["k"]] },
		context: "global",
	},
	{
		id: "nav.open",
		category: "nav",
		get label() {
			return m.command_nav_open();
		},
		bindings: { default: [["o"]] },
		context: "global",
	},
	{
		id: "task.toggleDone",
		category: "task",
		get label() {
			return m.command_task_toggle_done();
		},
		bindings: { default: [["x"]] },
		context: "global",
	},
	// task.delete (Backspace / vim d d) is deferred until a task-delete UI exists
	// to bind [data-kbd-action="delete"] to; advertising it with no target would be
	// a dead binding.
];
