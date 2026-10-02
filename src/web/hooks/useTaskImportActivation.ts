import { useQuery } from "@rocicorp/zero/react";
import { useCallback, useMemo } from "react";
import { queries } from "../../zero/queries.ts";
import type { TaskNotificationActivation } from "../../zero/schema.gen.ts";

export type TaskImportActivationStatus =
	| "unknown"
	| "native"
	| "active"
	| "pending"
	| "blocked";

export function resolveTaskImportActivation(
	rows: readonly Pick<TaskNotificationActivation, "taskId" | "status">[],
	queryType: "unknown" | "complete" | "error",
	taskId: string | null | undefined,
	hasImportActivation?: unknown,
): TaskImportActivationStatus {
	if (queryType === "error" || taskId == null) return "unknown";
	const row = rows.find((candidate) => candidate.taskId === taskId);
	if (!row) return hasImportActivation === false ? "native" : "unknown";
	return row.status === "active" ||
		row.status === "pending" ||
		row.status === "blocked"
		? row.status
		: "unknown";
}

export function resolveCachedTaskImportActivation(
	rows: readonly Pick<TaskNotificationActivation, "taskId" | "status">[],
	queryType: "unknown" | "complete" | "error",
	taskId: string,
	byTask: ReadonlyMap<string, unknown>,
): TaskImportActivationStatus {
	return byTask.has(taskId)
		? resolveTaskImportActivation(rows, queryType, taskId, byTask.get(taskId))
		: "unknown";
}

export function taskActivationAllowsWrites(status: TaskImportActivationStatus) {
	return status === "native" || status === "active";
}

export function taskImportRecoveryKey(
	taskId: string,
	workspaceId: string,
	status: TaskImportActivationStatus,
) {
	return JSON.stringify([taskId, workspaceId, status]);
}

export function useTaskImportActivation(taskId: string | null | undefined) {
	const activation = useTaskImportActivationMap();
	const status = taskId == null ? "unknown" : activation.statusForTask(taskId);
	return {
		status,
		canWrite: taskActivationAllowsWrites(status),
		needsRecovery: status === "pending" || status === "blocked",
		loading: status === "unknown",
	};
}

export function useTaskImportActivationMap() {
	const [rows, details] = useQuery(queries.taskImportActivations.mine());
	const [tasks, taskDetails] = useQuery(queries.tasks.mine());
	const byTask = useMemo(
		() => new Map(tasks.map((task) => [task.id, task.hasImportActivation])),
		[tasks],
	);
	const statusForTask = useCallback(
		(taskId: string): TaskImportActivationStatus =>
			resolveCachedTaskImportActivation(
				rows,
				taskDetails.type === "error" ? "error" : details.type,
				taskId,
				byTask,
			),
		[rows, details.type, taskDetails.type, byTask],
	);
	const canWriteTask = useCallback(
		(taskId: string) => taskActivationAllowsWrites(statusForTask(taskId)),
		[statusForTask],
	);
	return useMemo(
		() => ({ statusForTask, canWriteTask }),
		[statusForTask, canWriteTask],
	);
}
