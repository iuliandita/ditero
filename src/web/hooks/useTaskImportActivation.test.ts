import { expect, test } from "vitest";
import {
	resolveCachedTaskImportActivation,
	resolveTaskImportActivation,
	taskActivationAllowsWrites,
	taskImportRecoveryKey,
} from "./useTaskImportActivation.ts";

test("an absent guard requires an explicit native task marker", () => {
	expect(resolveTaskImportActivation([], "unknown", "task")).toBe("unknown");
	expect(resolveTaskImportActivation([], "complete", "task", false)).toBe(
		"native",
	);
	expect(resolveTaskImportActivation([], "complete", "", false)).toBe("native");
	expect(resolveTaskImportActivation([], "complete", " ", false)).toBe(
		"native",
	);
	expect(resolveTaskImportActivation([], "complete", null)).toBe("unknown");
	expect(taskActivationAllowsWrites("unknown")).toBe(false);
	expect(taskActivationAllowsWrites("native")).toBe(true);
});

test("review identity keys distinguish arbitrary task and workspace IDs", () => {
	expect(taskImportRecoveryKey("a:b", "c", "pending")).not.toBe(
		taskImportRecoveryKey("a", "b:c", "pending"),
	);
	expect(taskImportRecoveryKey("a", "b", "pending")).not.toBe(
		taskImportRecoveryKey("a", "b", "blocked"),
	);
});

test("pending and blocked rows keep affected writes disabled, including offline", () => {
	const pending = [{ taskId: "task", status: "pending" }];
	const blocked = [{ taskId: "task", status: "blocked" }];
	expect(resolveTaskImportActivation(pending, "complete", "task")).toBe(
		"pending",
	);
	expect(
		resolveTaskImportActivation(
			[{ taskId: "", status: "pending" }],
			"complete",
			"",
		),
	).toBe("pending");
	expect(resolveTaskImportActivation(blocked, "complete", "task")).toBe(
		"blocked",
	);
	expect(resolveTaskImportActivation(pending, "unknown", "task")).toBe(
		"pending",
	);
	expect(taskActivationAllowsWrites("pending")).toBe(false);
	expect(taskActivationAllowsWrites("blocked")).toBe(false);
	expect(taskActivationAllowsWrites("active")).toBe(true);
});

test("cached evidence allows writes without query completeness and old caches fail closed", () => {
	expect(resolveTaskImportActivation([], "unknown", "task", false)).toBe(
		"native",
	);
	for (const flag of [true, undefined, null, "false"]) {
		expect(resolveTaskImportActivation([], "complete", "task", flag)).toBe(
			"unknown",
		);
	}
	expect(
		resolveTaskImportActivation(
			[{ taskId: "task", status: "active" }],
			"unknown",
			"task",
			true,
		),
	).toBe("active");
	expect(
		resolveTaskImportActivation(
			[{ taskId: "task", status: "active" }],
			"error",
			"task",
			false,
		),
	).toBe("unknown");
	expect(
		resolveTaskImportActivation(
			[{ taskId: "task", status: "blocked" }],
			"unknown",
			"task",
			false,
		),
	).toBe("blocked");
});

test("a cached active guard requires the task to remain present", () => {
	const rows = [{ taskId: "task", status: "active" }];
	expect(
		resolveCachedTaskImportActivation(rows, "unknown", "task", new Map()),
	).toBe("unknown");
	expect(
		taskActivationAllowsWrites(
			resolveCachedTaskImportActivation(rows, "complete", "task", new Map()),
		),
	).toBe(false);
	expect(
		resolveCachedTaskImportActivation(
			rows,
			"unknown",
			"task",
			new Map([["task", undefined]]),
		),
	).toBe("active");
	expect(
		resolveCachedTaskImportActivation(
			[],
			"unknown",
			"task",
			new Map([["task", false]]),
		),
	).toBe("native");
});
