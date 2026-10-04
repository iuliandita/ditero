import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { KeyboardSensor, SensorContext } from "@dnd-kit/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

type SensorConstructor = typeof KeyboardSensor;
const require = createRequire(import.meta.url);
const packageRoot = dirname(require.resolve("@dnd-kit/core"));
const esm = (await import(
	pathToFileURL(join(packageRoot, "core.esm.js")).href
)) as {
	KeyboardSensor: SensorConstructor;
};
const development = require(
	join(packageRoot, "core.cjs.development.js"),
) as typeof esm;
const production = require(
	join(packageRoot, "core.cjs.production.min.js"),
) as typeof esm;

function mainEntry(environment: string) {
	const previous = process.env.NODE_ENV;
	try {
		process.env.NODE_ENV = environment;
		delete require.cache[join(packageRoot, "index.js")];
		return require(join(packageRoot, "index.js")) as typeof esm;
	} finally {
		if (previous === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = previous;
		delete require.cache[join(packageRoot, "index.js")];
	}
}

const mainDevelopment = mainEntry("development");
const mainProduction = mainEntry("production");

class KeyboardEventFixture extends Event {
	constructor(readonly code: string) {
		super("keydown", { cancelable: true });
	}
}

let documentTarget: EventTarget;
let windowTarget: EventTarget;

beforeEach(() => {
	vi.useFakeTimers();
	documentTarget = new EventTarget();
	windowTarget = new EventTarget();
	vi.stubGlobal("document", documentTarget);
	vi.stubGlobal(
		"window",
		Object.assign(windowTarget, {
			document: documentTarget,
			KeyboardEvent: KeyboardEventFixture,
		}),
	);
});

afterEach(() => {
	vi.runAllTimers();
	windowTarget.dispatchEvent(new Event("resize"));
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function lift(Sensor: SensorConstructor) {
	const onStart = vi.fn();
	const onMove = vi.fn();
	const onEnd = vi.fn();
	const onCancel = vi.fn();
	const coordinateGetter = vi.fn(
		(
			event: KeyboardEvent,
			{ currentCoordinates }: { currentCoordinates: { x: number; y: number } },
		) =>
			event.code === "ArrowDown"
				? { x: currentCoordinates.x, y: currentCoordinates.y + 44 }
				: undefined,
	);
	const activation = new KeyboardEventFixture("Space");
	const target = new EventTarget();
	target.addEventListener(
		"keydown",
		(event) => {
			new Sensor({
				active: "first",
				activeNode: {
					id: "first",
					key: "first",
					data: { current: {} },
					node: { current: null },
					activatorNode: { current: null },
				},
				event,
				// Scrolling and drag geometry belong to the browser control. This
				// fixture supplies only the context consumed by the keyboard sensor.
				context: {
					current: {
						collisionRect: { left: 16, top: 16 },
						scrollableAncestors: [],
					} as unknown as SensorContext,
				},
				options: { coordinateGetter },
				onStart,
				onMove,
				onEnd,
				onCancel,
				onAbort: vi.fn(),
				onPending: vi.fn(),
			});
		},
		{ once: true },
	);
	target.dispatchEvent(activation);
	expect(onStart).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 0 });
	return { activation, coordinateGetter, onMove, onEnd, onCancel };
}

function key(code: string) {
	const event = new KeyboardEventFixture(code);
	documentTarget.dispatchEvent(event);
	return event;
}

test("the package main selects the actual development and production runtimes", () => {
	expect(mainDevelopment.KeyboardSensor).toBe(development.KeyboardSensor);
	expect(mainProduction.KeyboardSensor).toBe(production.KeyboardSensor);
});

for (const [entry, Sensor] of [
	["ESM", esm.KeyboardSensor],
	["development CJS", development.KeyboardSensor],
	["production CJS", production.KeyboardSensor],
	["development package main", mainDevelopment.KeyboardSensor],
	["production package main", mainProduction.KeyboardSensor],
] as const) {
	describe(entry, () => {
		test("ignores only the activating event and moves on the first distinct Arrow before timers run", () => {
			const callbacks = lift(Sensor);
			// The same native event reaches document after target activation.
			documentTarget.dispatchEvent(callbacks.activation);
			expect(callbacks.onEnd).not.toHaveBeenCalled();
			expect(callbacks.onCancel).not.toHaveBeenCalled();
			expect(callbacks.coordinateGetter).not.toHaveBeenCalled();
			const arrow = key("ArrowDown");
			expect(callbacks.coordinateGetter).toHaveBeenCalledTimes(1);
			expect(callbacks.coordinateGetter.mock.calls[0][0]).toBe(arrow);
			expect(callbacks.onMove).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 44 });
			expect(arrow.defaultPrevented).toBe(true);
		});

		for (const code of ["Space", "Enter"]) {
			test(`a distinct ${code} ends the drag and removes its listeners`, () => {
				const callbacks = lift(Sensor);
				documentTarget.dispatchEvent(callbacks.activation);
				const end = key(code);
				expect(callbacks.onEnd).toHaveBeenCalledTimes(1);
				expect(end.defaultPrevented).toBe(true);
				vi.runAllTimers();
				key("ArrowDown");
				key("Space");
				windowTarget.dispatchEvent(new Event("resize"));
				expect(callbacks.onMove).not.toHaveBeenCalled();
				expect(callbacks.onEnd).toHaveBeenCalledTimes(1);
				expect(callbacks.onCancel).not.toHaveBeenCalled();
			});
		}

		test("Escape cancellation removes listeners", () => {
			const callbacks = lift(Sensor);
			// Also exercise cancellation after a functioning listener is present.
			vi.runAllTimers();
			key("ArrowDown");
			expect(callbacks.onMove).toHaveBeenCalledTimes(1);
			key("Escape");
			expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
			key("ArrowDown");
			key("Space");
			windowTarget.dispatchEvent(new Event("resize"));
			expect(callbacks.onMove).toHaveBeenCalledTimes(1);
			expect(callbacks.onEnd).not.toHaveBeenCalled();
			expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
		});

		for (const event of ["resize", "visibilitychange"]) {
			test(`${event} cancellation cannot install a late keyboard listener`, () => {
				const callbacks = lift(Sensor);
				windowTarget.dispatchEvent(new Event(event));
				expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
				vi.runAllTimers();
				key("ArrowDown");
				key("Space");
				expect(callbacks.coordinateGetter).not.toHaveBeenCalled();
				expect(callbacks.onMove).not.toHaveBeenCalled();
				expect(callbacks.onEnd).not.toHaveBeenCalled();
				expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
			});
		}
	});
}
