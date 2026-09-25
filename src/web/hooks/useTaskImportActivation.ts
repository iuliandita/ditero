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
	complete: boolean,
	taskId: string | null | undefined,
): TaskImportActivationStatus {
	if (!complete || taskId == null) return "unknown";
	const row = rows.find((candidate) => candidate.taskId === taskId);
	if (!row) return "native";
	return row.status === "active" ||
		row.status === "pending" ||
		row.status === "blocked"
		? row.status
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
	const [rows, details] = useQuery(queries.taskImportActivations.mine());
	const status = useMemo(
		() =>
			resolveTaskImportActivation(rows, details.type === "complete", taskId),
		[rows, details.type, taskId],
	);
	return {
		status,
		canWrite: taskActivationAllowsWrites(status),
		needsRecovery: status === "pending" || status === "blocked",
		loading: status === "unknown",
	};
}

export function useTaskImportActivationMap() {
	const [rows, details] = useQuery(queries.taskImportActivations.mine());
	const complete = details.type === "complete";
	const byTask = useMemo(
		() => new Map(rows.map((row) => [row.taskId, row.status])),
		[rows],
	);
	const statusForTask = useCallback(
		(taskId: string): TaskImportActivationStatus => {
			if (!complete) return "unknown";
			const status = byTask.get(taskId);
			return status === "active" || status === "pending" || status === "blocked"
				? status
				: status === undefined
					? "native"
					: "unknown";
		},
		[complete, byTask],
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
