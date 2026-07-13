import { describe, expect, test } from "vitest";
import {
	CHORD_MODIFIERS,
	type CommandDef,
	contextsOverlap,
	findConflicts,
	MODIFIER_KEYS,
	resolveKeymap,
} from "./keymap.ts";

const cmds: CommandDef[] = [
	{
		id: "task.create",
		category: "task",
		label: "New task",
		bindings: { default: [["c"]], vim: [["c"]] },
		context: "global",
	},
	{
		id: "nav.down",
		category: "nav",
		label: "Move down",
		bindings: { default: [["ArrowDown"]], vim: [["j"]] },
		context: "list",
	},
];

describe("resolveKeymap", () => {
	test("default profile, no overrides, returns default bindings", () => {
		const eff = resolveKeymap(cmds, "default", {});
		expect(eff).toEqual({
			"task.create": [["c"]],
			"nav.down": [["ArrowDown"]],
		});
	});

	test("vim profile swaps movement binding", () => {
		const eff = resolveKeymap(cmds, "vim", {});
		expect(eff["nav.down"]).toEqual([["j"]]);
	});

	test("vim profile falls back to default when no vim binding", () => {
		const noVim: CommandDef[] = [
			{
				id: "task.done",
				category: "task",
				label: "Complete",
				bindings: { default: [["x"]] },
				context: "list",
			},
		];
		const eff = resolveKeymap(noVim, "vim", {});
		expect(eff["task.done"]).toEqual([["x"]]);
	});

	test("override beats profile", () => {
		const eff = resolveKeymap(cmds, "vim", { "nav.down": [["k"]] });
		expect(eff["nav.down"]).toEqual([["k"]]);
	});

	test("override beats default", () => {
		const eff = resolveKeymap(cmds, "default", { "task.create": [["n"]] });
		expect(eff["task.create"]).toEqual([["n"]]);
	});

	test("override replaces bindings entirely (no merge)", () => {
		const multi: CommandDef[] = [
			{
				id: "task.create",
				category: "task",
				label: "New task",
				bindings: { default: [["c"], ["n"]] },
				context: "global",
			},
		];
		const eff = resolveKeymap(multi, "default", { "task.create": [["a"]] });
		expect(eff["task.create"]).toEqual([["a"]]);
	});

	test("every command id present in effective keymap", () => {
		const eff = resolveKeymap(cmds, "default", {});
		expect(Object.keys(eff).sort()).toEqual(["nav.down", "task.create"]);
	});
});

describe("findConflicts", () => {
	test("two globals on the same key conflict", () => {
		const c: CommandDef[] = [
			{
				id: "a",
				category: "x",
				label: "A",
				bindings: { default: [["g"]] },
				context: "global",
			},
			{
				id: "b",
				category: "x",
				label: "B",
				bindings: { default: [["g"]] },
				context: "global",
			},
		];
		const eff = resolveKeymap(c, "default", {});
		expect(findConflicts(eff, c)).toEqual([["a", "b"]]);
	});

	test("same key in equal non-global context conflicts (list+list)", () => {
		const c: CommandDef[] = [
			{
				id: "a",
				category: "x",
				label: "A",
				bindings: { default: [["j"]] },
				context: "list",
			},
			{
				id: "b",
				category: "x",
				label: "B",
				bindings: { default: [["j"]] },
				context: "list",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([
			["a", "b"],
		]);
	});

	test("same key in different non-global contexts does not conflict", () => {
		const c: CommandDef[] = [
			{
				id: "a",
				category: "x",
				label: "A",
				bindings: { default: [["j"]] },
				context: "list",
			},
			{
				id: "b",
				category: "x",
				label: "B",
				bindings: { default: [["j"]] },
				context: "board",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([]);
	});

	test("global overlaps a non-global context", () => {
		const c: CommandDef[] = [
			{
				id: "a",
				category: "x",
				label: "A",
				bindings: { default: [["k"]] },
				context: "global",
			},
			{
				id: "b",
				category: "x",
				label: "B",
				bindings: { default: [["k"]] },
				context: "list",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([
			["a", "b"],
		]);
	});

	test("g-sequence is distinct from single g", () => {
		const c: CommandDef[] = [
			{
				id: "goto.inbox",
				category: "nav",
				label: "Go inbox",
				bindings: { default: [["g", "i"]] },
				context: "global",
			},
			{
				id: "group",
				category: "view",
				label: "Group",
				bindings: { default: [["g"]] },
				context: "global",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([]);
	});

	test("no conflict when keys differ", () => {
		const c: CommandDef[] = [
			{
				id: "a",
				category: "x",
				label: "A",
				bindings: { default: [["c"]] },
				context: "global",
			},
			{
				id: "b",
				category: "x",
				label: "B",
				bindings: { default: [["d"]] },
				context: "global",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([]);
	});

	test("conflict pair emitted once with sorted ids", () => {
		const c: CommandDef[] = [
			{
				id: "zeta",
				category: "x",
				label: "Z",
				bindings: { default: [["q"]] },
				context: "global",
			},
			{
				id: "alpha",
				category: "x",
				label: "A",
				bindings: { default: [["q"]] },
				context: "global",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([
			["alpha", "zeta"],
		]);
	});

	test("multiple conflicting pairs sorted deterministically", () => {
		const c: CommandDef[] = [
			{
				id: "a",
				category: "x",
				label: "A",
				bindings: { default: [["g"]] },
				context: "global",
			},
			{
				id: "b",
				category: "x",
				label: "B",
				bindings: { default: [["g"]] },
				context: "global",
			},
			{
				id: "c",
				category: "x",
				label: "C",
				bindings: { default: [["h"]] },
				context: "list",
			},
			{
				id: "d",
				category: "x",
				label: "D",
				bindings: { default: [["h"]] },
				context: "list",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([
			["a", "b"],
			["c", "d"],
		]);
	});

	test("shared binding among multiple bindings triggers conflict", () => {
		const c: CommandDef[] = [
			{
				id: "a",
				category: "x",
				label: "A",
				bindings: { default: [["c"], ["n"]] },
				context: "global",
			},
			{
				id: "b",
				category: "x",
				label: "B",
				bindings: { default: [["n"]] },
				context: "global",
			},
		];
		expect(findConflicts(resolveKeymap(c, "default", {}), c)).toEqual([
			["a", "b"],
		]);
	});
});

describe("contextsOverlap", () => {
	test("global overlaps everything, both directions", () => {
		expect(contextsOverlap("global", "global")).toBe(true);
		expect(contextsOverlap("global", "list")).toBe(true);
		expect(contextsOverlap("board", "global")).toBe(true);
	});

	test("non-global overlaps only itself", () => {
		expect(contextsOverlap("list", "list")).toBe(true);
		expect(contextsOverlap("list", "board")).toBe(false);
	});
});

describe("modifier sets", () => {
	test("MODIFIER_KEYS covers the named modifiers", () => {
		for (const k of ["Meta", "Control", "Ctrl", "Shift", "Alt"])
			expect(MODIFIER_KEYS.has(k)).toBe(true);
		expect(MODIFIER_KEYS.has("k")).toBe(false);
	});

	test("CHORD_MODIFIERS is the Meta/Ctrl subset", () => {
		expect(CHORD_MODIFIERS.has("Meta")).toBe(true);
		expect(CHORD_MODIFIERS.has("Control")).toBe(true);
		expect(CHORD_MODIFIERS.has("Shift")).toBe(false);
	});
});
