import { afterEach, describe, expect, test, vi } from "vitest";
import { resolveKeymap } from "../../domain/keymap.ts";
import { COMMANDS } from "./commands.ts";
import { createKeyHandler } from "./useKeyBindings.ts";

const keymap = resolveKeymap(COMMANDS, "default", {});

// Synthetic KeyboardEvent-shaped object: the matcher is duck-typed and DOM-free,
// so a plain object with a `target` stub exercises the real code under node.
function evt(init: {
	key: string;
	metaKey?: boolean;
	ctrlKey?: boolean;
	shiftKey?: boolean;
	target?: { tagName?: string; isContentEditable?: boolean };
}) {
	return { preventDefault: () => {}, ...init };
}

const INPUT = { tagName: "INPUT" } as const;

afterEach(() => {
	vi.useRealTimers();
});

describe("useKeyBindings engine", () => {
	test("single key fires its command", () => {
		const run = vi.fn();
		createKeyHandler(keymap, run).onKeyDown(evt({ key: "c" }));
		expect(run).toHaveBeenCalledExactlyOnceWith("task.create");
	});

	test("single keys are inert inside editable elements", () => {
		const run = vi.fn();
		createKeyHandler(keymap, run).onKeyDown(evt({ key: "c", target: INPUT }));
		expect(run).not.toHaveBeenCalled();
	});

	test("Meta+k opens the palette even from a text input", () => {
		const run = vi.fn();
		const h = createKeyHandler(keymap, run);
		h.onKeyDown(evt({ key: "k", metaKey: true, target: INPUT }));
		h.onKeyDown(evt({ key: "c", target: INPUT }));
		expect(run).toHaveBeenCalledExactlyOnceWith("palette.open");
	});

	test("g then t completes the nav.today sequence", () => {
		vi.useFakeTimers();
		const run = vi.fn();
		const h = createKeyHandler(keymap, run);
		h.onKeyDown(evt({ key: "g" }));
		expect(run).not.toHaveBeenCalled();
		h.onKeyDown(evt({ key: "t" }));
		expect(run).toHaveBeenCalledExactlyOnceWith("nav.today");
	});

	test("a lone prefix that times out fires nothing", () => {
		vi.useFakeTimers();
		const run = vi.fn();
		const h = createKeyHandler(keymap, run);
		h.onKeyDown(evt({ key: "g" }));
		vi.advanceTimersByTime(900);
		h.onKeyDown(evt({ key: "t" }));
		expect(run).not.toHaveBeenCalled();
	});

	test("Meta+k and Ctrl+k both open the palette", () => {
		const run = vi.fn();
		const h = createKeyHandler(keymap, run);
		h.onKeyDown(evt({ key: "k", metaKey: true }));
		h.onKeyDown(evt({ key: "k", ctrlKey: true }));
		expect(run).toHaveBeenCalledTimes(2);
		expect(run).toHaveBeenNthCalledWith(1, "palette.open");
		expect(run).toHaveBeenNthCalledWith(2, "palette.open");
	});

	test("an unbound key fires nothing", () => {
		const run = vi.fn();
		createKeyHandler(keymap, run).onKeyDown(evt({ key: "z" }));
		expect(run).not.toHaveBeenCalled();
	});

	test("Shift+ArrowDown extends the selection; a bare ArrowDown does not", () => {
		const run = vi.fn();
		const h = createKeyHandler(keymap, run);
		h.onKeyDown(evt({ key: "ArrowDown" }));
		h.onKeyDown(evt({ key: "ArrowDown", shiftKey: true }));
		expect(run).toHaveBeenCalledExactlyOnceWith("selection.extendDown");
	});

	test("a shifted printable key still resolves as a single key", () => {
		const run = vi.fn();
		createKeyHandler(keymap, run).onKeyDown(evt({ key: "?", shiftKey: true }));
		expect(run).toHaveBeenCalledExactlyOnceWith("help.cheatSheet");
	});

	test("Ctrl+A stays with a text field; only the palette chord fires there", () => {
		const run = vi.fn();
		const h = createKeyHandler(keymap, run);
		h.onKeyDown(evt({ key: "a", ctrlKey: true, target: INPUT }));
		expect(run).not.toHaveBeenCalled();
		h.onKeyDown(evt({ key: "a", ctrlKey: true }));
		expect(run).toHaveBeenCalledExactlyOnceWith("selection.all");
	});

	test("a command that cannot run leaves the key to the browser", () => {
		const run = vi.fn();
		const preventDefault = vi.fn();
		const h = createKeyHandler(keymap, run, {
			canRun: (id) => !id.startsWith("selection."),
		});
		h.onKeyDown({ key: "a", metaKey: true, preventDefault });
		h.onKeyDown({ key: "Escape", preventDefault });
		h.onKeyDown({ key: "s", preventDefault });
		expect(run).not.toHaveBeenCalled();
		expect(preventDefault).not.toHaveBeenCalled();
		h.onKeyDown({ key: "c", preventDefault });
		expect(run).toHaveBeenCalledExactlyOnceWith("task.create");
	});
});
