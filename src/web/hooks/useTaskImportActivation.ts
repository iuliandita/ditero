import { useQuery, useZero } from "@rocicorp/zero/react";
import { useCallback, useMemo } from "react";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";
import { queries } from "../../zero/queries.ts";
import type {
	schema,
	TaskNotificationActivation,
} from "../../zero/schema.gen.ts";

export type TaskImportActivationStatus =
	| "unknown"
	| "native"
	| "active"
	| "pending"
	| "blocked";

export function resolveTaskImportActivation(
	rows: readonly Pick<TaskNotificationActivation, "taskId" | "status">[],
	queryType: "unknown" | "cached" | "complete" | "error",
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
	queryType: "unknown" | "cached" | "complete" | "error",
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
		canWrite: taskId != null && activation.canWriteTask(taskId),
		canWriteWorkspace:
			taskId != null && activation.canWriteTaskWorkspace(taskId),
		needsRecovery: status === "pending" || status === "blocked",
		loading: status === "unknown",
	};
}

export function useWorkspaceWriteAccess() {
	const zero = useZero<typeof schema>();
	const [memberships] = useQuery(queries.memberships.mine());
	return useCallback(
		(workspaceId: string) =>
			memberships.some(
				(row) =>
					row.userId === zero.userID &&
					row.workspaceId === workspaceId &&
					WRITE_ROLES.has(row.role as Role),
			),
		[memberships, zero.userID],
	);
}

export function useTaskImportActivationMap() {
	const canWriteWorkspace = useWorkspaceWriteAccess();
	const [lists] = useQuery(queries.lists.mine());
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
	const writableTasks = useMemo(() => {
		const writableLists = new Set(
			lists
				.filter((list) => canWriteWorkspace(list.workspaceId))
				.map((list) => list.id),
		);
		return new Set(
			tasks
				.filter((task) => writableLists.has(task.listId))
				.map((task) => task.id),
		);
	}, [tasks, lists, canWriteWorkspace]);
	const canWriteTaskWorkspace = useCallback(
		(taskId: string) => writableTasks.has(taskId),
		[writableTasks],
	);
	const canWriteTask = useCallback(
		(taskId: string) =>
			canWriteTaskWorkspace(taskId) &&
			taskActivationAllowsWrites(statusForTask(taskId)),
		[statusForTask, canWriteTaskWorkspace],
	);
	return useMemo(
		() => ({ statusForTask, canWriteTask, canWriteTaskWorkspace }),
		[statusForTask, canWriteTask, canWriteTaskWorkspace],
	);
}
