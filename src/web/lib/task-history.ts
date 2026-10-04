import {
	type HistoryCursor,
	historyPageSchema,
} from "../../domain/task-history.ts";

export class TaskHistoryUnavailableError extends Error {}
export class TaskHistoryTransportError extends Error {}
export async function loadTaskHistory(
	taskId: string,
	workspaceId: string,
	cursor: HistoryCursor | null,
	signal: AbortSignal,
) {
	const parameters = new URLSearchParams({ taskId, workspaceId });
	if (cursor) parameters.set("cursor", JSON.stringify(cursor));
	let response: Response;
	try {
		response = await fetch(`/api/tasks/history?${parameters}`, {
			credentials: "same-origin",
			cache: "no-store",
			signal,
		});
	} catch (error) {
		if (!signal.aborted && error instanceof TypeError)
			throw new TaskHistoryTransportError();
		throw error;
	}
	if ([401, 403, 404].includes(response.status))
		throw new TaskHistoryUnavailableError();
	if (!response.ok) throw new Error("History load failed");
	return historyPageSchema.parse(await response.json());
}
