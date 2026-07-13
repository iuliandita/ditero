import { describe, expect, test } from "vitest";
import { EMPTY_CAPTURE, stepCapture } from "./capture.ts";

describe("stepCapture", () => {
	test("completes a Meta chord, normalized to ['Meta', key]", () => {
		const r = stepCapture(EMPTY_CAPTURE, {
			key: "k",
			metaKey: true,
			ctrlKey: false,
		});
		expect(r.binding).toEqual(["Meta", "k"]);
	});

	test("normalizes a Ctrl chord to Meta", () => {
		const r = stepCapture(EMPTY_CAPTURE, {
			key: "p",
			metaKey: false,
			ctrlKey: true,
		});
		expect(r.binding).toEqual(["Meta", "p"]);
	});

	test("ignores a bare modifier keydown", () => {
		const r = stepCapture(EMPTY_CAPTURE, {
			key: "Shift",
			metaKey: false,
			ctrlKey: false,
		});
		expect(r.binding).toBeNull();
		expect(r.state).toEqual(EMPTY_CAPTURE);
	});

	test("ignores a held modifier with no real key yet (Meta alone)", () => {
		const r = stepCapture(EMPTY_CAPTURE, {
			key: "Meta",
			metaKey: true,
			ctrlKey: false,
		});
		expect(r.binding).toBeNull();
	});

	test("completes a single key", () => {
		const r = stepCapture(EMPTY_CAPTURE, {
			key: "j",
			metaKey: false,
			ctrlKey: false,
		});
		expect(r.binding).toEqual(["j"]);
	});
});
