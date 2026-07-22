import { describe, expect, test, vi } from "vitest";
import { CRASH_POINTS, crashHook } from "./test-crash.ts";

describe("crashHook", () => {
	test("is inert when the variable is unset", () => {
		const kill = vi.fn();
		const hook = crashHook({ NODE_ENV: "test" }, kill);
		for (const point of CRASH_POINTS) hook(point);
		expect(kill).not.toHaveBeenCalled();
	});

	test("is inert when the variable is empty or whitespace", () => {
		const kill = vi.fn();
		for (const raw of ["", "   "]) {
			const hook = crashHook(
				{ NODE_ENV: "test", DITERO_TEST_CRASH_POINT: raw },
				kill,
			);
			for (const point of CRASH_POINTS) hook(point);
		}
		expect(kill).not.toHaveBeenCalled();
	});

	// The whole point of the guard: an operator who leaves the variable in a
	// production environment gets a running server, not a crash loop.
	test("is inert in production even when armed", () => {
		const kill = vi.fn();
		const hook = crashHook(
			{ NODE_ENV: "production", DITERO_TEST_CRASH_POINT: "after-send" },
			kill,
		);
		for (const point of CRASH_POINTS) hook(point);
		expect(kill).not.toHaveBeenCalled();
	});

	test("fires only at the armed point", () => {
		const kill = vi.fn();
		const hook = crashHook(
			{ NODE_ENV: "test", DITERO_TEST_CRASH_POINT: "after-send" },
			kill,
		);
		hook("before-send");
		hook("mid-claim");
		hook("mid-scan");
		expect(kill).not.toHaveBeenCalled();
		hook("after-send");
		expect(kill).toHaveBeenCalledTimes(1);
	});

	test("rejects an unknown point at boot rather than silently ignoring it", () => {
		expect(() =>
			crashHook({ NODE_ENV: "test", DITERO_TEST_CRASH_POINT: "whenever" }),
		).toThrow(/DITERO_TEST_CRASH_POINT/);
	});
});
