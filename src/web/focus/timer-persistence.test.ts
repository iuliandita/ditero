import { describe, expect, test } from "vitest";
import { DEFAULT_FOCUS, INITIAL_CYCLE } from "./timer-core.ts";
import {
	focusStorageKey,
	intervalFields,
	restoreFocus,
	serializeFocus,
} from "./timer-persistence.ts";

describe("focus persistence", () => {
	test.each([
		true,
		false,
	])("restores running=%s with task, instants and interval config", (running) => {
		const state = {
			...intervalFields({ ...DEFAULT_FOCUS, autoCycle: false }),
			cycle: INITIAL_CYCLE,
			plannedSec: 1500,
			running,
			startedAt: 1000,
			endsAt: running ? 1501000 : null,
			pausedAt: running ? null : 2000,
			remainingSec: 1499,
			boundTaskId: "task",
			boundTaskTitle: "Read",
		};
		expect(restoreFocus(serializeFocus(state))).toEqual(state);
	});
	test("preserves expired instants for natural completion and isolates account/server keys", () => {
		const state = {
			...intervalFields(DEFAULT_FOCUS),
			cycle: INITIAL_CYCLE,
			plannedSec: 1,
			running: true,
			startedAt: 0,
			endsAt: 1000,
			remainingSec: 0,
			boundTaskId: null,
			boundTaskTitle: null,
		};
		expect(restoreFocus(serializeFocus(state))?.endsAt).toBe(1000);
		expect(focusStorageKey("a")).not.toBe(focusStorageKey("b"));
		expect(focusStorageKey("a", "one")).not.toBe(focusStorageKey("a", "two"));
	});
	test.each([
		null,
		"oops",
		'{"version":2}',
		'{"version":1,"session":{"running":true}}',
	])("ignores unsupported or damaged storage: %j", (raw) => {
		expect(restoreFocus(raw)).toBeNull();
	});
});
