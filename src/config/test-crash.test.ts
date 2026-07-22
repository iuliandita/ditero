import { describe, expect, test, vi } from "vitest";
import { CRASH_POINTS, crashHook } from "./test-crash.ts";

describe("crashHook", () => {
	test("is inert when the variable is unset", () => {
		const kill = vi.fn();
		expect(crashHook({ NODE_ENV: "test" }, kill)).toBeUndefined();
		expect(kill).not.toHaveBeenCalled();
	});

	test("is inert when the variable is empty or whitespace", () => {
		const kill = vi.fn();
		for (const raw of ["", "   "]) {
			expect(
				crashHook({ NODE_ENV: "test", DITERO_TEST_CRASH_POINT: raw }, kill),
			).toBeUndefined();
		}
		expect(kill).not.toHaveBeenCalled();
	});

	// The allowlist is the control. A deny-list on "production" would arm the
	// seam for every other value -- including no NODE_ENV at all, which is how a
	// self-hoster running `bun src/server/index.ts` starts the server.
	test.each([
		["production", "production"],
		["unset", undefined],
		["empty", ""],
		["staging", "staging"],
		["prod", "prod"],
		["Test (wrong case)", "Test"],
		["development", "development"],
	])("is inert when NODE_ENV is %s, even when armed", (_label, nodeEnv) => {
		const kill = vi.fn();
		expect(
			crashHook(
				{ NODE_ENV: nodeEnv, DITERO_TEST_CRASH_POINT: "after-send" },
				kill,
			),
		).toBeUndefined();
		expect(kill).not.toHaveBeenCalled();
	});

	test("fires only at the armed point", () => {
		const kill = vi.fn();
		const hook = crashHook(
			{ NODE_ENV: "test", DITERO_TEST_CRASH_POINT: "after-send" },
			kill,
		);
		expect(hook).toBeDefined();
		hook?.("before-send");
		hook?.("mid-claim");
		hook?.("mid-scan");
		expect(kill).not.toHaveBeenCalled();
		hook?.("after-send");
		expect(kill).toHaveBeenCalledTimes(1);
	});

	test("every declared point is reachable", () => {
		for (const point of CRASH_POINTS) {
			const kill = vi.fn();
			crashHook(
				{ NODE_ENV: "test", DITERO_TEST_CRASH_POINT: point },
				kill,
			)?.(point);
			expect(kill).toHaveBeenCalledTimes(1);
		}
	});

	test("rejects an unknown point at boot rather than silently ignoring it", () => {
		expect(() =>
			crashHook({ NODE_ENV: "test", DITERO_TEST_CRASH_POINT: "whenever" }),
		).toThrow(/DITERO_TEST_CRASH_POINT/);
	});

	// Outside the allowlist nothing is parsed at all, so a stale or misspelled
	// value in a production environment is inert rather than a boot failure.
	test("does not even parse the value outside the allowlist", () => {
		expect(
			crashHook({
				NODE_ENV: "production",
				DITERO_TEST_CRASH_POINT: "whenever",
			}),
		).toBeUndefined();
	});
});
