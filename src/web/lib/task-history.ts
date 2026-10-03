import {
	type HistoryCursor,
	historyPageSchema,
} from "../../domain/task-history.ts";

export class TaskHistoryUnavailableError extends Error {}
export async function loadTaskHistory(
	taskId: string,
	workspaceId: string,
	cursor: HistoryCursor | null,
	signal: AbortSignal,
) {
	const parameters = new URLSearchParams({ taskId, workspaceId });
	if (cursor) parameters.set("cursor", JSON.stringify(cursor));
	const response = await fetch(`/api/tasks/history?${parameters}`, {
		credentials: "same-origin",
		cache: "no-store",
		signal,
	});
	if ([401, 403, 404].includes(response.status))
		throw new TaskHistoryUnavailableError();
	if (!response.ok) throw new Error("History load failed");
	return historyPageSchema.parse(await response.json());
}
