import { z } from "zod";
import type { TaskIntent } from "../agent/task-plan.ts";
import type { CliOptions } from "../cli/arguments.ts";
import { CliError } from "../cli/arguments.ts";
import { discover, type Fetcher, requestJson } from "../cli/client.ts";
import { commentWorkflow } from "../cli/comment-workflow.ts";
import { taskWorkflow } from "../cli/task-workflow.ts";
import {
	type ApiCommentSnapshot,
	apiCommentSnapshotSchema,
} from "../domain/public-api-comments.ts";
import {
	type PublicApiResource,
	publicApiResourceSchemas,
} from "../domain/public-api-resources.ts";
import {
	type ApiTaskDelete,
	apiTaskDeletionObservationSchema,
} from "../domain/public-api-task-deletion.ts";
import {
	type ApiTaskUpdate,
	apiTaskObservationSchema,
} from "../domain/public-api-task-update.ts";
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
export const COMMENT_PAGE_SIZE = 50;
export interface CommentPage {
	comments: ApiCommentSnapshot[];
	nextCursor: string | null;
}
export interface Proposal {
	version: 1;
	task: ApiTaskCreate;
	target: { kind: "list" | "dashboard"; id: string };
	timezone: string;
	resolvedAt: string;
}
export type TaskObservation = z.infer<typeof apiTaskObservationSchema>;
export type DeletionObservation = z.infer<
	typeof apiTaskDeletionObservationSchema
>;

export interface TerminalApi {
	observe(taskId: string, signal: AbortSignal): Promise<TaskObservation>;
	observeDeletion(
		taskId: string,
		signal: AbortSignal,
	): Promise<DeletionObservation>;
	update(
		taskId: string,
		body: ApiTaskUpdate,
		requestId: string,
		signal: AbortSignal,
	): Promise<void>;
	delete(
		taskId: string,
		body: ApiTaskDelete,
		requestId: string,
		signal: AbortSignal,
	): Promise<void>;
	read(location: Location, signal: AbortSignal): Promise<Page>;
	comments(
		taskId: string,
		cursor: string | undefined,
		signal: AbortSignal,
	): Promise<CommentPage>;
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
		async observe(taskId, signal) {
			const result = await taskWorkflow(
				{ ...options, command: "observe-task", taskId },
				fetcher,
				undefined,
				signal,
			);
			const observation = z
				.object({ data: apiTaskObservationSchema })
				.parse(result).data;
			if (observation.snapshot.taskId !== taskId)
				throw new CliError(
					"invalid_response",
					"The server returned an observation for another task.",
					8,
				);
			return observation;
		},
		async observeDeletion(taskId, signal) {
			const result = await taskWorkflow(
				{ ...options, command: "observe-task-deletion", taskId },
				fetcher,
				undefined,
				signal,
			);
			const observation = z
				.object({ data: apiTaskDeletionObservationSchema })
				.parse(result).data;
			if (observation.snapshot.taskId !== taskId)
				throw new CliError(
					"invalid_response",
					"The server returned an observation for another task.",
					8,
				);
			return observation;
		},
		async update(taskId, body, requestId, signal) {
			await taskWorkflow(
				{ ...options, command: "update-task", taskId, requestId },
				fetcher,
				encode(body),
				signal,
			);
		},
		async delete(taskId, body, requestId, signal) {
			await taskWorkflow(
				{ ...options, command: "delete-task", taskId, requestId },
				fetcher,
				encode(body),
				signal,
			);
		},
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
		async comments(taskId, cursor, signal) {
			const result = await commentWorkflow(
				{
					...options,
					command: "list-task-comments",
					taskId,
					cursor,
					all: false,
					limit: COMMENT_PAGE_SIZE,
					workspaceId: undefined,
					listId: undefined,
					commentId: undefined,
					requestId: undefined,
					done: undefined,
				},
				fetcher,
				undefined,
				signal,
			);
			const page = z
				.object({
					data: z.array(apiCommentSnapshotSchema).max(COMMENT_PAGE_SIZE),
					nextCursor: z.string().nullable(),
				})
				.parse(result);
			if (page.data.some((comment) => comment.taskId !== taskId))
				throw new CliError(
					"invalid_response",
					"The server returned a comment for another task.",
					8,
				);
			// The database forbids these provenance combinations; fail closed
			// before any view, including exact JSON, can display them.
			if (
				page.data.some(
					(comment) =>
						(comment.historicalAuthorKind === "unknown" &&
							comment.historicalAuthorName !== null) ||
						(comment.provenanceRedactedAt !== null &&
							(comment.historicalAuthorKind !== "unknown" ||
								comment.historicalAuthorName !== null)),
				)
			)
				throw new CliError(
					"invalid_response",
					"The server returned inconsistent comment provenance.",
					8,
				);
			return { comments: page.data, nextCursor: page.nextCursor };
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
