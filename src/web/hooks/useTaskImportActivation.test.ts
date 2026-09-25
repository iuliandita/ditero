import { expect, test } from "vitest";
import {
	resolveTaskImportActivation,
	taskActivationAllowsWrites,
	taskImportRecoveryKey,
} from "./useTaskImportActivation.ts";

test("an absent guard is native only after the status query completes", () => {
	expect(resolveTaskImportActivation([], false, "task")).toBe("unknown");
	expect(resolveTaskImportActivation([], true, "task")).toBe("native");
	expect(resolveTaskImportActivation([], true, "")).toBe("native");
	expect(resolveTaskImportActivation([], true, " ")).toBe("native");
	expect(resolveTaskImportActivation([], true, null)).toBe("unknown");
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
	expect(resolveTaskImportActivation(pending, true, "task")).toBe("pending");
	expect(
		resolveTaskImportActivation([{ taskId: "", status: "pending" }], true, ""),
	).toBe("pending");
	expect(resolveTaskImportActivation(blocked, true, "task")).toBe("blocked");
	expect(resolveTaskImportActivation(pending, false, "task")).toBe("unknown");
	expect(taskActivationAllowsWrites("pending")).toBe(false);
	expect(taskActivationAllowsWrites("blocked")).toBe(false);
	expect(taskActivationAllowsWrites("active")).toBe(true);
});
