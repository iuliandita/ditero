import { z } from "zod";
import type { TaskIntent } from "../agent/task-plan.ts";
import type { CliOptions } from "../cli/arguments.ts";
import { CliError } from "../cli/arguments.ts";
import { discover, type Fetcher, requestJson } from "../cli/client.ts";
import { taskWorkflow } from "../cli/task-workflow.ts";
import {
	type PublicApiResource,
	publicApiResourceSchemas,
} from "../domain/public-api-resources.ts";
import type { ApiTaskCreate } from "../domain/public-api-writes.ts";

export interface Location {
	resource: PublicApiResource;
	workspaceId?: string;
	listId?: string;
	cursor?: string;
}
export interface Entry {
	id: string;
	label: string;
	data: Record<string, unknown>;
}
export interface Page {
	entries: Entry[];
	nextCursor: string | null;
}
export interface Proposal {
	version: 1;
	task: ApiTaskCreate;
	target: { kind: "list" | "dashboard"; id: string };
	timezone: string;
	resolvedAt: string;
}
export interface TerminalApi {
	read(location: Location, signal: AbortSignal): Promise<Page>;
	plan(intent: TaskIntent, signal: AbortSignal): Promise<Proposal>;
	create(
		task: ApiTaskCreate,
		requestId: string,
		signal: AbortSignal,
	): Promise<void>;
	complete(
		task: { id: string; listId: string; dueAt: string | null },
		requestId: string,
		signal: AbortSignal,
	): Promise<void>;
}

export function terminalApi(
	options: CliOptions,
	fetcher: Fetcher = fetch,
): TerminalApi {
	const encode = (value: unknown) => async () =>
		new TextEncoder().encode(JSON.stringify(value));
	return {
		async read(location, signal) {
			const result = await discover(
				{
					...options,
					...location,
					command: location.resource,
					all: false,
					limit: 100,
					done: undefined,
				},
				fetcher,
				undefined,
				signal,
			);
			const rows = z
				.array(publicApiResourceSchemas[location.resource])
				.parse(result.data);
			return {
				entries: rows.map((row) => ({
					id: row.id,
					label: `${"done" in row ? (row.done ? "[x] " : "[ ] ") : ""}${"title" in row ? row.title : row.name}`,
					data: row,
				})),
				nextCursor: result.nextCursor,
			};
		},
		async plan(intent, signal) {
			return (await taskWorkflow(
				{ ...options, command: "plan-task" },
				fetcher,
				encode(intent),
				signal,
			)) as Proposal;
		},
		async create(task, requestId, signal) {
			await taskWorkflow(
				{ ...options, command: "create-task", requestId },
				fetcher,
				encode(task),
				signal,
			);
		},
		async complete(task, requestId, signal) {
			const result = await requestJson(
				options,
				new URL(
					`/api/v1/tasks/${encodeURIComponent(task.id)}/complete`,
					options.server,
				),
				fetcher,
				{
					requestId,
					body: JSON.stringify({
						listId: task.listId,
						expectedDueAt: task.dueAt,
					}),
				},
				undefined,
				signal,
			);
			if (
				!z
					.object({
						version: z.literal(1),
						data: publicApiResourceSchemas.tasks,
						nextCursor: z.null(),
					})
					.strict()
					.safeParse(result).success
			)
				throw new CliError(
					"invalid_response",
					"The server returned an invalid task response.",
					8,
				);
		},
	};
}
