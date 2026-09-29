import { describe, expect, test, vi } from "vitest";
import {
	canRunCommand,
	registerSelectionTarget,
	runSelectionCommand,
} from "./selection-commands.ts";

describe("selection command registry", () => {
	test("with no list open, selection keys stay unclaimed", () => {
		expect(canRunCommand("selection.all")).toBe(false);
		expect(canRunCommand("selection.clear")).toBe(false);
		expect(canRunCommand("task.create")).toBe(true);
	});

	test("the open list decides and receives its commands", () => {
		const run = vi.fn();
		const off = registerSelectionTarget({
			run,
			can: (command) => command !== "clear",
		});
		expect(canRunCommand("selection.all")).toBe(true);
		expect(canRunCommand("selection.clear")).toBe(false);
		runSelectionCommand("toggle");
		expect(run).toHaveBeenCalledExactlyOnceWith("toggle");
		off();
		expect(canRunCommand("selection.all")).toBe(false);
	});

	test("a stale unregister does not drop the newer list", () => {
		const offOld = registerSelectionTarget({ run: () => {}, can: () => true });
		const offNew = registerSelectionTarget({ run: () => {}, can: () => true });
		offOld();
		expect(canRunCommand("selection.toggle")).toBe(true);
		offNew();
	});
});
