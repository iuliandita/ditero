import { describe, expect, test } from "vitest";
import { findConflicts, resolveKeymap } from "../../domain/keymap.ts";
import { COMMANDS } from "./commands.ts";

describe("COMMANDS registry", () => {
	test("all ids are unique", () => {
		const ids = COMMANDS.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every command has a category and a bindings.default array", () => {
		for (const cmd of COMMANDS) {
			expect(cmd.category).toBeTruthy();
			expect(Array.isArray(cmd.bindings.default)).toBe(true);
		}
	});

	test("default profile has no binding conflicts", () => {
		const km = resolveKeymap(COMMANDS, "default", {});
		expect(findConflicts(km, COMMANDS)).toEqual([]);
	});
});
