import { afterEach, expect, test, vi } from "vitest";
import { installNativeBack, NATIVE_NAVIGATE_BACK } from "./native-back.ts";

afterEach(() => vi.unstubAllGlobals());

test.each([
	"overlay",
	"navigation",
	"root",
])("Android Back consumes %s before permitting Activity exit", (surface) => {
	const window = new EventTarget();
	const active = new EventTarget();
	const onEscape = vi.fn();
	active.addEventListener("keydown", onEscape);
	const navigation = vi.fn((event: Event) => {
		if (surface === "navigation") event.preventDefault();
	});
	window.addEventListener(NATIVE_NAVIGATE_BACK, navigation);
	vi.stubGlobal("window", window);
	vi.stubGlobal("document", {
		querySelector: () => (surface === "overlay" ? {} : null),
		activeElement: active,
	});
	vi.stubGlobal("KeyboardEvent", Event);
	const dispose = installNativeBack();
	const event = new Event("ditero:native-back", { cancelable: true });
	expect(window.dispatchEvent(event)).toBe(surface === "root");
	expect(onEscape).toHaveBeenCalledTimes(surface === "overlay" ? 1 : 0);
	expect(navigation).toHaveBeenCalledTimes(surface === "overlay" ? 0 : 1);
	dispose();
	expect(
		window.dispatchEvent(new Event("ditero:native-back", { cancelable: true })),
	).toBe(true);
});
