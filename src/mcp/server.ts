import {
	McpServer,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { taskIntentSchema } from "../agent/task-plan.ts";
import { CliError, type CliOptions, parseArguments } from "../cli/arguments.ts";
import { discover, type Fetcher } from "../cli/client.ts";
import {
	commentWorkflow,
	encodeCommentInput,
} from "../cli/comment-workflow.ts";
import {
	encodeFolderWorkflowInput,
	folderWorkflow,
} from "../cli/folder-workflow.ts";
import {
	encodeListDeletionInput,
	encodeListInput,
	listWorkflow,
	safeListInput,
} from "../cli/list-workflow.ts";
import {
	encodeTaskPlacementInput,
	taskPlacementWorkflow,
} from "../cli/task-placement-workflow.ts";
import {
	encodeTaskRelationshipsInput,
	safeRelationshipObject,
	safeTaskRelationshipsInput,
	taskRelationshipsWorkflow,
} from "../cli/task-relationships-workflow.ts";
import { taskWorkflow } from "../cli/task-workflow.ts";
import { webhookWorkflow } from "../cli/webhook-workflow.ts";
import { clientBuild } from "../clients/build-info.ts";
import { PUBLIC_API_ID, PUBLIC_API_PAGE_SIZE } from "../domain/public-api.ts";
import {
	type ApiCommentOperation,
	apiCommentAckSchema,
	apiCommentCreateSchema,
	apiCommentDeleteSchema,
	apiCommentIdSchema,
	apiCommentObservationSchema,
	apiCommentSnapshotSchema,
	apiCommentUpdateSchema,
} from "../domain/public-api-comments.ts";
import { apiTaskCompleteSchema } from "../domain/public-api-completion.ts";
import {
	apiFolderCreateAckSchema,
	apiFolderCreateSchema,
	apiFolderDeleteAckSchema,
	apiFolderDeleteSchema,
	apiFolderObservationSchema,
	apiFolderUpdateAckSchema,
	apiFolderUpdateSchema,
} from "../domain/public-api-folder.ts";
import {
	apiListCreateSchema,
	apiListCreationAckSchema,
} from "../domain/public-api-list-create.ts";
import {
	apiListDeleteAckSchema,
	apiListDeleteSchema,
	apiListDeletionObservationSchema,
} from "../domain/public-api-list-deletion.ts";
import {
	apiListObservationSchema,
	apiListUpdateAckSchema,
	apiListUpdateSchema,
} from "../domain/public-api-list-update.ts";
import {
	PUBLIC_API_RESOURCES,
	publicApiProfileSchema,
	publicApiResourceSchemas,
} from "../domain/public-api-resources.ts";
import {
	apiTaskDeletedSchema,
	apiTaskDeleteSchema,
	apiTaskDeletionObservationSchema,
} from "../domain/public-api-task-deletion.ts";
import {
	apiTaskPlacementAckSchema,
	apiTaskPlacementObservationSchema,
	apiTaskPlacementSchema,
} from "../domain/public-api-task-placement.ts";
import {
	apiTaskRelationshipObservationSchema,
	apiTaskRelationshipSnapshotSchema,
	apiTaskRelationshipsAckSchema,
	apiTaskRelationshipsSchema,
} from "../domain/public-api-task-relationships.ts";
import {
	apiTaskObservationSchema,
	apiTaskUpdateSchema,
} from "../domain/public-api-task-update.ts";
import {
	webhookCreatedSchema,
	webhookCreateSchema,
	webhookMetadataSchema,
	webhookRevokedSchema,
} from "../domain/public-api-webhook.ts";
import { apiTaskCreateSchema } from "../domain/public-api-writes.ts";

function safeInput(value: unknown, depth = 0): boolean {
	if (depth > 32) return false;
	if (!value || typeof value !== "object") return true;
	if (Object.getOwnPropertySymbols(value).length) return false;
	return Object.entries(value).every(
		([key, child]) =>
			!["__proto__", "constructor", "prototype"].includes(key) &&
			safeInput(child, depth + 1),
	);
}

function guardedInput<S extends z.ZodType>(
	schema: S,
	listPayload?: "list" | "update" | "observation" | "deletion",
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
	const standard = schema["~standard"];
	return {
		"~standard": {
			...standard,
			validate: async (value) => {
				const invalid = {
					issues: [{ message: "Invalid or oversized tool arguments." }],
				};
				if (listPayload) {
					if (!safeListInput(value)) return invalid;
					if (listPayload === "deletion") {
						const parsed = await standard.validate(value);
						if (parsed.issues) return invalid;
					}
					try {
						if (listPayload !== "observation") {
							const payload = (value as Record<string, unknown>)[listPayload];
							if (listPayload === "deletion") encodeListDeletionInput(payload);
							else encodeListInput(payload);
						}
					} catch {
						return invalid;
					}
				}
				if (!safeInput(value)) return invalid;
				try {
					if (
						new TextEncoder().encode(JSON.stringify(value)).byteLength > 65_536
					)
						return invalid;
					const result = await standard.validate(value);
					return result.issues ? invalid : result;
				} catch {
					return invalid;
				}
			},
		},
	};
}

function guardedFolderInput<S extends z.ZodType>(
	schema: S,
	command: CliOptions["command"],
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
	const standard = schema["~standard"];
	return {
		"~standard": {
			...standard,
			validate: async (value) => {
				const invalid = {
					issues: [{ message: "Invalid or oversized folder arguments." }],
				};
				try {
					if (!safeListInput(value)) return invalid;
					if (command !== "observe-folder")
						encodeFolderWorkflowInput(
							command,
							(value as Record<string, unknown>).folder,
						);
					if (
						new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536
					)
						return invalid;
					const result = await standard.validate(value);
					return result.issues ? invalid : result;
				} catch {
					return invalid;
				}
			},
		},
	};
}
function guardedRelationshipsInput<S extends z.ZodType>(
	schema: S,
	writing: boolean,
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
	const standard = schema["~standard"];
	return {
		"~standard": {
			...standard,
			validate: async (value) => {
				const invalid = {
					issues: [{ message: "Invalid or oversized relationship arguments." }],
				};
				try {
					if (
						!safeRelationshipObject(
							value,
							writing ? ["taskId", "requestId", "relationships"] : ["taskId"],
						)
					)
						return invalid;
					if (writing && !safeTaskRelationshipsInput(value.relationships))
						return invalid;
					const result = await standard.validate(value);
					if (result.issues) return invalid;
					if (writing)
						encodeTaskRelationshipsInput(
							(result.value as Record<string, unknown>).relationships,
						);
					if (
						new TextEncoder().encode(JSON.stringify(result.value)).byteLength >
						65_536
					)
						return invalid;
					return result;
				} catch {
					return invalid;
				}
			},
		},
	};
}

function guardedPlacementInput<S extends z.ZodType>(
	schema: S,
	writing: boolean,
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
	const standard = schema["~standard"];
	return {
		"~standard": {
			...standard,
			validate: async (value) => {
				const invalid = {
					issues: [{ message: "Invalid or oversized placement arguments." }],
				};
				try {
					if (
						!safeRelationshipObject(
							value,
							writing ? ["taskId", "requestId", "placement"] : ["taskId"],
						)
					)
						return invalid;
					if (writing) encodeTaskPlacementInput(value.placement);
					const result = await standard.validate(value);
					if (result.issues) return invalid;
					if (writing)
						encodeTaskPlacementInput(
							(result.value as Record<string, unknown>).placement,
						);
					if (
						new TextEncoder().encode(JSON.stringify(result.value)).byteLength >
						65_536
					)
						return invalid;
					return result;
				} catch {
					return invalid;
				}
			},
		},
	};
}

function guardedCommentInput<S extends z.ZodType>(
	schema: S,
	fields: readonly string[],
	operation?: ApiCommentOperation,
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
	const standard = schema["~standard"];
	return {
		"~standard": {
			...standard,
			validate: async (value) => {
				const invalid = {
					issues: [{ message: "Invalid or oversized comment arguments." }],
				};
				try {
					if (!safeRelationshipObject(value, fields)) return invalid;
					if (operation) encodeCommentInput(operation, value.comment);
					const result = await standard.validate(value);
					if (result.issues) return invalid;
					if (
						new TextEncoder().encode(JSON.stringify(result.value)).length >
						65536
					)
						return invalid;
					return result;
				} catch {
					return invalid;
				}
			},
		},
	};
}

const pageFields = {
	limit: z.number().int().min(1).max(100).optional(),
	cursor: z
		.string()
		.regex(/^[A-Za-z0-9_-]{1,2048}$/)
		.optional(),
	workspaceId: PUBLIC_API_ID.optional(),
};
const pageInput = z.object(pageFields).strict();
const taskInput = pageInput
	.extend({ listId: PUBLIC_API_ID.optional(), done: z.boolean().optional() })
	.strict();
const annotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
};
const nextCursor = z
	.string()
	.regex(/^[A-Za-z0-9_-]{1,2048}$/)
	.nullable();

export function mcpConfiguration(
	env: Record<string, string | undefined>,
	argv: string[] = [],
): CliOptions {
	if (
		argv.length > 1 ||
		(argv.length === 1 && argv[0] !== "--allow-loopback-http")
	)
		throw new CliError(
			"invalid_arguments",
			"Only --allow-loopback-http is supported at startup.",
			2,
		);
	const options = parseArguments(["profile", ...argv], env);
	if (!options)
		throw new CliError(
			"invalid_configuration",
			"MCP configuration is required.",
			2,
		);
	return Object.freeze(options);
}

export function createDiteroMcp(
	configuration: CliOptions,
	fetcher: Fetcher = fetch,
): McpServer {
	const fixed = Object.freeze({ ...configuration });
	const server = new McpServer(
		{ name: "ditero", version: clientBuild.version },
		{ capabilities: { tools: {} }, maxToolInputElements: 256 },
	);
	let active = 0;
	async function execute(operation: () => Promise<unknown>) {
		try {
			if (active >= 4)
				throw new CliError(
					"busy",
					"Four tool calls are already running. Try again shortly.",
					6,
					429,
				);
			active++;
			try {
				const result = await operation();
				// Every operation returns a validated, versioned object.
				const output = result as Record<string, unknown>;
				return {
					content: [{ type: "text" as const, text: JSON.stringify(output) }],
					structuredContent: output,
				};
			} finally {
				active--;
			}
		} catch (error) {
			const failure =
				error instanceof CliError
					? error
					: new CliError(
							"internal_error",
							"The tool call could not be completed.",
							9,
						);
			const output = {
				version: 1,
				error: {
					code: failure.code,
					status: failure.status,
					message: failure.message,
					...(failure.choices?.length ? { choices: failure.choices } : {}),
				},
			};
			return {
				isError: true,
				content: [{ type: "text" as const, text: JSON.stringify(output) }],
				structuredContent: output,
			};
		}
	}
	function read(
		command: CliOptions["command"],
		args: {
			limit?: number;
			cursor?: string;
			workspaceId?: string;
			listId?: string;
			done?: boolean;
		},
	) {
		return execute(() =>
			discover(
				{
					...fixed,
					command,
					all: false,
					limit: args.limit ?? PUBLIC_API_PAGE_SIZE,
					cursor: args.cursor,
					workspaceId: args.workspaceId,
					listId: args.listId,
					done: args.done === undefined ? undefined : String(args.done),
				},
				fetcher,
			),
		);
	}
	function workflow(
		command: CliOptions["command"],
		input: unknown,
		requestId?: string,
		taskId?: string,
	) {
		return execute(() =>
			taskWorkflow(
				{ ...fixed, command, requestId, taskId },
				fetcher,
				async () => new TextEncoder().encode(JSON.stringify(input)),
			),
		);
	}
	server.registerTool(
		"get_profile",
		{
			description:
				"Read the configured account's profile, timezone choice, locale, and token access.",
			inputSchema: guardedInput(z.object({}).strict()),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: publicApiProfileSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations,
		},
		() => read("profile", {}),
	);
	for (const resource of PUBLIC_API_RESOURCES) {
		server.registerTool(
			`list_${resource}`,
			{
				description: `Read one member-visible ${resource} page. Continue with nextCursor and unchanged filters.`,
				inputSchema: guardedInput(resource === "tasks" ? taskInput : pageInput),
				outputSchema: z
					.object({
						version: z.literal(1),
						data: z.array(publicApiResourceSchemas[resource]).max(100),
						nextCursor,
					})
					.strict(),
				annotations,
			},
			(args) => read(resource, args),
		);
	}
	server.registerTool(
		"plan_task",
		{
			description:
				"Resolve a task intent against bounded authorized discovery without writing. Inspect the proposal and resolve ambiguous choices before creation.",
			inputSchema: guardedInput(taskIntentSchema),
			annotations,
		},
		(intent) => workflow("plan-task", intent),
	);
	server.registerTool(
		"create_task",
		{
			description:
				"Create one task from an inspected canonical proposal and an explicit UUID requestId. Reuse exactly that key and task after an uncertain outcome; conflicts and deleted replays are never recreated automatically.",
			inputSchema: guardedInput(
				z.object({ requestId: z.uuid(), task: apiTaskCreateSchema }).strict(),
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: publicApiResourceSchemas.tasks,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: { ...annotations, readOnlyHint: false },
		},
		({ requestId, task }) =>
			workflow("create-task", task, requestId.toLowerCase()),
	);
	server.registerTool(
		"complete_task",
		{
			description:
				"Complete an inspected task using its previously observed listId and expectedDueAt (null when undated), plus an explicit UUID requestId. Recurring completion advances that observed occurrence. After an uncertain outcome, explicitly retry the identical completion body and key; never read a new due instant or choose a new key for that retry.",
			inputSchema: guardedInput(
				z
					.object({
						taskId: PUBLIC_API_ID,
						requestId: z.uuid(),
						completion: apiTaskCompleteSchema,
					})
					.strict(),
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: publicApiResourceSchemas.tasks,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ taskId, requestId, completion }) =>
			workflow("complete-task", completion, requestId.toLowerCase(), taskId),
	);
	for (const deletion of [false, true]) {
		server.registerTool(
			deletion ? "get_task_deletion_observation" : "get_task_observation",
			{
				description: deletion
					? "Read the current task scalar snapshot and observed persisted child count/token. Inspect both states before deletion; related comments, files and assignments are part of the explicit deletion scope."
					: "Read the current task scalar snapshot and opaque state token. Inspect this live observation before updating; it does not lock the task or describe relationships.",
				inputSchema: guardedInput(z.object({ taskId: PUBLIC_API_ID }).strict()),
				outputSchema: z
					.object({
						version: z.literal(1),
						data: deletion
							? apiTaskDeletionObservationSchema
							: apiTaskObservationSchema,
						nextCursor: z.null(),
					})
					.strict(),
				annotations,
			},
			({ taskId }) =>
				workflow(
					deletion ? "observe-task-deletion" : "observe-task",
					undefined,
					undefined,
					taskId,
				),
		);
	}
	server.registerTool(
		"update_task",
		{
			description:
				"Update an inspected task's title, notes, dueAt, dueAllDay or priority using its previously observed listId and stateToken as expectedState, plus an explicit UUID requestId. Omitted fields stay unchanged; null clears notes/dueAt. Recurring tasks and habits reject due-field patches. Send one PATCH; after an uncertain outcome retry the identical body and key without reading a replacement token. Replay returns the current authorized task or 410 if deleted. Keys share the account mutation namespace.",
			inputSchema: guardedInput(
				z
					.object({
						taskId: PUBLIC_API_ID,
						requestId: z.uuid(),
						update: apiTaskUpdateSchema,
					})
					.strict(),
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: publicApiResourceSchemas.tasks,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ taskId, requestId, update }) =>
			workflow("update-task", update, requestId.toLowerCase(), taskId),
	);
	server.registerTool(
		"delete_task",
		{
			description:
				"Delete an inspected task using its observed listId, parent stateToken as expectedState, childrenState as expectedChildrenState, explicit cascadeChildren, and UUID requestId. False requires no children; true deletes the exact observed children and dependent comments/files/assignments. Send one DELETE with a body bounded to 4 KiB. After an uncertain result retry the identical body and key without replacing observations. Replay acknowledges the original deletion even if the task ID is recreated; current origin-list write authority is required. Keys share the account mutation namespace.",
			inputSchema: guardedInput(
				z
					.object({
						taskId: PUBLIC_API_ID,
						requestId: z.uuid(),
						deletion: apiTaskDeleteSchema,
					})
					.strict(),
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiTaskDeletedSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ taskId, requestId, deletion }) =>
			workflow("delete-task", deletion, requestId.toLowerCase(), taskId),
	);
	function listOperation(
		command: CliOptions["command"],
		payload: unknown,
		requestId: string | undefined,
		listId: string | undefined,
		signal: AbortSignal,
	) {
		return execute(() =>
			listWorkflow(
				{ ...fixed, command, requestId, listId },
				fetcher,
				async () =>
					command === "delete-list"
						? encodeListDeletionInput(payload)
						: encodeListInput(payload),
				signal,
			),
		);
	}
	server.registerTool(
		"create_list",
		{
			description:
				"Create one root list from explicit workspaceId, title, kind and optional icon plus caller-owned UUID requestId. Send one POST. Retry uncertain outcomes with the exact UUID/body; replay returns the immutable original creation acknowledgement, not current state. No invitations or access grants.",
			inputSchema: guardedInput(
				z.object({ requestId: z.uuid(), list: apiListCreateSchema }).strict(),
				"list",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiListCreationAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: { ...annotations, readOnlyHint: false },
		},
		({ requestId, list }, ctx) =>
			listOperation(
				"create-list",
				list,
				requestId.toLowerCase(),
				undefined,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"get_list_observation",
		{
			description:
				"Read the current strict ApiList scalar snapshot and semantic state token for listId. Read tokens and viewers may observe. Covers all list scalar fields, not relationships; it is not a lock, monotonic revision or incarnation identity. Identical state including identical recreation may match again.",
			inputSchema: guardedInput(
				z.object({ listId: PUBLIC_API_ID }).strict(),
				"observation",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiListObservationSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations,
		},
		({ listId }, ctx) =>
			listOperation(
				"observe-list",
				undefined,
				undefined,
				listId,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"update_list",
		{
			description:
				"Update title, icon, completedDisplay, same-workspace folderId and fractional sortKey using previously observed workspaceId/stateToken as expectedState and caller-owned UUID requestId. folderId may be null to detach; sortKey must be a valid opaque base-62 fractional key of 2-256 ASCII characters. Sibling order is not observed. Send one PATCH within 4 KiB without hidden reads, retry or rebase. Stale state returns 409. Exact replay returns the immutable original post-update acknowledgement even after deletion/recreation; current original-workspace write authority is required.",
			inputSchema: guardedInput(
				z
					.object({
						listId: PUBLIC_API_ID,
						requestId: z.uuid(),
						update: apiListUpdateSchema,
					})
					.strict(),
				"update",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiListUpdateAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ listId, requestId, update }, ctx) =>
			listOperation(
				"update-list",
				update,
				requestId.toLowerCase(),
				listId,
				ctx.mcpReq.signal,
			),
	);

	server.registerTool(
		"get_list_deletion_observation",
		{
			description:
				"Read the complete authorized list deletion observation, including scalar state and count/token evidence for all persisted tasks. Read tokens and Viewers may observe. Inspect the explicit cascade scope; this is a live observation, not a lock or incarnation identity.",
			inputSchema: guardedInput(
				z.object({ listId: PUBLIC_API_ID }).strict(),
				"observation",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiListDeletionObservationSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations,
		},
		({ listId }, ctx) =>
			listOperation(
				"observe-list-deletion",
				undefined,
				undefined,
				listId,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"delete_list",
		{
			description:
				"Delete one inspected list using original workspaceId, expectedState, complete expectedTasksState and explicit cascadeTasks plus caller-owned UUID requestId. False requires no tasks; true accepts the observed task cascade and native dependent cleanup. Send one DELETE within 4 KiB without hidden reads or retries. Exact replay returns the immutable original acknowledgement and deletedTasks count without deleting a recreated list. Current original-workspace creator/Admin/Owner authority remains required. After uncertain cancellation or transport failure, manually retry the identical list ID, body and UUID without replacing state.",
			inputSchema: guardedInput(
				z
					.object({
						listId: PUBLIC_API_ID,
						requestId: z.uuid(),
						deletion: apiListDeleteSchema,
					})
					.strict(),
				"deletion",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiListDeleteAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ listId, requestId, deletion }, ctx) =>
			listOperation(
				"delete-list",
				deletion,
				requestId.toLowerCase(),
				listId,
				ctx.mcpReq.signal,
			),
	);

	function relationshipsOperation(
		command: CliOptions["command"],
		taskId: string,
		payload: unknown,
		requestId: string | undefined,
		signal: AbortSignal,
	) {
		return execute(() =>
			taskRelationshipsWorkflow(
				{ ...fixed, command, taskId, requestId },
				fetcher,
				async () => encodeTaskRelationshipsInput(payload),
				signal,
			),
		);
	}
	server.registerTool(
		"get_task_relationship_observation",
		{
			description:
				"Read the complete current task/list/workspace scope and assignee/label ID sets with a semantic state token. Read tokens and Viewers may observe. This does not lock the task or fingerprint scalar fields, label names or other dependent content.",
			inputSchema: guardedRelationshipsInput(
				z
					.object({ taskId: apiTaskRelationshipSnapshotSchema.shape.taskId })
					.strict(),
				false,
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiTaskRelationshipObservationSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations,
		},
		({ taskId }, ctx) =>
			relationshipsOperation(
				"observe-task-relationships",
				taskId,
				undefined,
				undefined,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"update_task_relationships",
		{
			description:
				"Replace an inspected task's complete assigneeIds and labelIds using explicit original workspaceId/listId, expectedState and caller UUID requestId. Both arrays are required; empty arrays explicitly clear them. Up to 20 unique active original-workspace members and 50 unique same-workspace labels; no invitations or label resource edits. Send one strict 64 KiB PATCH without hidden reads, merging, retries or replacement state. Current Member+ and write PAT authority remain required, including replay. Success returns immutable original scope/sets, not current state; exact replay never edits a recreated task or duplicates notices. After uncertain cancellation or transport failure, manually retry the identical task ID, body and UUID.",
			inputSchema: guardedRelationshipsInput(
				z
					.object({
						taskId: apiTaskRelationshipSnapshotSchema.shape.taskId,
						requestId: z.uuid(),
						relationships: apiTaskRelationshipsSchema,
					})
					.strict(),
				true,
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiTaskRelationshipsAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ taskId, requestId, relationships }, ctx) =>
			relationshipsOperation(
				"update-task-relationships",
				taskId,
				relationships,
				requestId.toLowerCase(),
				ctx.mcpReq.signal,
			),
	);

	function placementOperation(
		command: CliOptions["command"],
		taskId: string,
		payload: unknown,
		requestId: string | undefined,
		signal: AbortSignal,
	) {
		return execute(() =>
			taskPlacementWorkflow(
				{ ...fixed, command, taskId, requestId },
				fetcher,
				async () => encodeTaskPlacementInput(payload),
				signal,
			),
		);
	}
	server.registerTool(
		"get_task_placement_observation",
		{
			description:
				"Read current task placement, original list/workspace and complete children state. Supply a separate explicit list observation token for the chosen target; this read does not lock rows.",
			inputSchema: guardedPlacementInput(
				z.object({ taskId: PUBLIC_API_ID }).strict(),
				false,
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiTaskPlacementObservationSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations,
		},
		({ taskId }, ctx) =>
			placementOperation(
				"observe-task-placement",
				taskId,
				undefined,
				undefined,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"place_task",
		{
			description:
				"Order a task in its list or relocate a root and its explicitly observed children to a same-workspace, same-kind list. Supply exact observations, sortKey, cascade policy and caller UUID. One 4 KiB PATCH; no hidden reads or retries. Replay acknowledges the original effect; manually retry identical body/key after uncertainty.",
			inputSchema: guardedPlacementInput(
				z
					.object({
						taskId: PUBLIC_API_ID,
						requestId: z.uuid(),
						placement: apiTaskPlacementSchema,
					})
					.strict(),
				true,
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiTaskPlacementAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ taskId, requestId, placement }, ctx) =>
			placementOperation(
				"place-task",
				taskId,
				placement,
				requestId.toLowerCase(),
				ctx.mcpReq.signal,
			),
	);

	function commentOperation(
		command: CliOptions["command"],
		args: {
			taskId: string;
			commentId?: string;
			requestId?: string;
			limit?: number;
			cursor?: string;
		},
		payload: unknown,
		operation: ApiCommentOperation | undefined,
		signal: AbortSignal,
	) {
		return execute(() =>
			commentWorkflow(
				{
					...fixed,
					...args,
					command,
					limit: args.limit ?? PUBLIC_API_PAGE_SIZE,
				},
				fetcher,
				async () =>
					operation ? encodeCommentInput(operation, payload) : new Uint8Array(),
				signal,
			),
		);
	}
	const commentPageOutput = z
		.object({
			version: z.literal(1),
			data: z.array(apiCommentSnapshotSchema).max(100),
			nextCursor,
		})
		.strict();
	const commentObservationOutput = z
		.object({
			version: z.literal(1),
			data: apiCommentObservationSchema,
			nextCursor: z.null(),
		})
		.strict();
	const commentAckOutput = z
		.object({
			version: z.literal(1),
			data: apiCommentAckSchema,
			nextCursor: z.null(),
		})
		.strict();
	server.registerTool(
		"list_task_comments",
		{
			description:
				"Read one bounded task-scoped page of full comment bodies. Explicit taskId, limit 1-100 and task-bound cursor only. Read PAT and current members including Viewers may read. At most 256 KiB, no truncation or automatic pagination; private provenance is never exposed.",
			inputSchema: guardedCommentInput(
				z
					.object({
						taskId: apiCommentIdSchema,
						limit: pageFields.limit,
						cursor: pageFields.cursor,
					})
					.strict(),
				["taskId", "limit", "cursor"],
			),
			outputSchema: commentPageOutput,
			annotations,
		},
		(args, ctx) =>
			commentOperation(
				"list-task-comments",
				args,
				undefined,
				undefined,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"get_comment_observation",
		{
			description:
				"Observe an explicitly selected task/comment in one GET. Compact body SHA256/UTF8 byte count and semantic token cover stored fields, hidden provenance and precise timestamps. No lock or incarnation guarantee; read PAT and current members may observe.",
			inputSchema: guardedCommentInput(
				z
					.object({ taskId: apiCommentIdSchema, commentId: apiCommentIdSchema })
					.strict(),
				["taskId", "commentId"],
			),
			outputSchema: commentObservationOutput,
			annotations,
		},
		(args, ctx) =>
			commentOperation(
				"observe-comment",
				args,
				undefined,
				undefined,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"create_task_comment",
		{
			description:
				"Create one comment with original workspace/list and observed expectedTaskState, exact untrimmed body and caller UUID. Native 10000-character bound and 64 KiB JSON. Creation-only lexical mentions notify current members after commit without invitation or access grants. One POST; immutable original acknowledgment. No hidden reads or retries. Current write PAT/Member+ required including replay; manually retry identical body/key after uncertainty.",
			inputSchema: guardedCommentInput(
				z
					.object({
						taskId: apiCommentIdSchema,
						requestId: z.uuid(),
						comment: apiCommentCreateSchema,
					})
					.strict(),
				["taskId", "requestId", "comment"],
				"create",
			),
			outputSchema: commentAckOutput,
			annotations: { ...annotations, readOnlyHint: false },
		},
		({ comment, ...args }, ctx) =>
			commentOperation(
				"add-comment",
				args,
				comment,
				"create",
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"update_task_comment",
		{
			description:
				"Edit the observed native author's comment with original workspace/list, expectedState, exact untrimmed body and caller UUID. One PATCH within 64 KiB, no character cap, mention event, hidden reads or retries. Current original-workspace author/write authority required including replay. Imported comments cannot be edited. Immutable acknowledgment survives deletion/recreation; retry identical IDs/body/key after uncertainty.",
			inputSchema: guardedCommentInput(
				z
					.object({
						taskId: apiCommentIdSchema,
						commentId: apiCommentIdSchema,
						requestId: z.uuid(),
						comment: apiCommentUpdateSchema,
					})
					.strict(),
				["taskId", "commentId", "requestId", "comment"],
				"update",
			),
			outputSchema: commentAckOutput,
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ comment, ...args }, ctx) =>
			commentOperation(
				"edit-comment",
				args,
				comment,
				"update",
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"delete_task_comment",
		{
			description:
				"Delete an observed comment with original workspace/list, expectedState, explicit comment-and-attachments scope and caller UUID. One DELETE within 4 KiB; committed attachments retire for GC. Current native author with write membership or Admin/Owner required; imported/null-author comments require Admin/Owner. Immutable compact acknowledgment never deletes a recreated row. No hidden reads or retries; retry identical IDs/body/key after uncertainty.",
			inputSchema: guardedCommentInput(
				z
					.object({
						taskId: apiCommentIdSchema,
						commentId: apiCommentIdSchema,
						requestId: z.uuid(),
						comment: apiCommentDeleteSchema,
					})
					.strict(),
				["taskId", "commentId", "requestId", "comment"],
				"delete",
			),
			outputSchema: commentAckOutput,
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ comment, ...args }, ctx) =>
			commentOperation(
				"delete-comment",
				args,
				comment,
				"delete",
				ctx.mcpReq.signal,
			),
	);

	function webhookOperation(
		command: CliOptions["command"],
		payload: unknown,
		webhookId: string | undefined,
		signal: AbortSignal,
	) {
		return execute(() =>
			webhookWorkflow(
				{
					...fixed,
					command,
					webhookId,
					revealSecret: command === "create-webhook",
				},
				fetcher,
				async () => new TextEncoder().encode(JSON.stringify(payload)),
				signal,
			),
		);
	}
	server.registerTool(
		"list_webhooks",
		{
			description:
				"Read webhook metadata (name, hint, list, workspace, expiry, revocation) for your webhooks, at most 100, active first. Secrets are never returned. One GET without paging or filters.",
			inputSchema: guardedInput(z.object({}).strict()),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: z.array(webhookMetadataSchema).max(100),
					nextCursor: z.null(),
				})
				.strict(),
			annotations,
		},
		(_, ctx) =>
			webhookOperation(
				"list-webhooks",
				undefined,
				undefined,
				ctx.mcpReq.signal,
			),
	);
	server.registerTool(
		"create_webhook",
		{
			description:
				"Create one webhook for a list with name (1-80 characters), listId and optional expiresInDays (1-365, default 90). Requires revealSecret: true because the one-time webhook secret is returned in this result, so it enters the client's context and cannot be fetched again. Each call creates another webhook (20 active maximum) and is never retried or replayed; list webhooks before repeating after an uncertain outcome. Requires a write token.",
			inputSchema: guardedInput(
				z
					.object({
						revealSecret: z.literal(true),
						webhook: webhookCreateSchema,
					})
					.strict(),
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: webhookCreatedSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				idempotentHint: false,
			},
		},
		({ webhook }, ctx) =>
			webhookOperation("create-webhook", webhook, undefined, ctx.mcpReq.signal),
	);
	server.registerTool(
		"revoke_webhook",
		{
			description:
				"Revoke one webhook by its UUID. One DELETE; revoking an already revoked webhook succeeds, so an uncertain outcome can be retried safely. Requires a write token.",
			inputSchema: guardedInput(z.object({ webhookId: z.uuid() }).strict()),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: webhookRevokedSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		({ webhookId }, ctx) =>
			webhookOperation(
				"revoke-webhook",
				undefined,
				webhookId.toLowerCase(),
				ctx.mcpReq.signal,
			),
	);

	const folderIdSchema = PUBLIC_API_ID.refine(
		(value) =>
			value !== "." &&
			value !== ".." &&
			!value.includes("\0") &&
			!/[\uD800-\uDFFF]/u.test(value),
	);
	server.registerTool(
		"get_folder_observation",
		{
			description:
				"Read one member-visible folder snapshot and semantic stateToken. Read tokens and Viewers may observe. Tokens are not locks or incarnation identities. One request within 4 KiB without hidden reads, retries or rebase. Writes return immutable original acknowledgments, including replay after deletion/recreation, under current original-workspace write authority. Preserve identical ID/body/UUID for an uncertain manual retry.",
			inputSchema: guardedFolderInput(
				z.object({ folderId: folderIdSchema }).strict(),
				"observe-folder",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiFolderObservationSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: true,
				destructiveHint: false,
			},
		},
		(args, ctx) =>
			execute(() =>
				folderWorkflow(
					{
						...fixed,
						command: "observe-folder",
						folderId: args.folderId,
						requestId: undefined,
					},
					fetcher,
					async () => encodeFolderWorkflowInput("observe-folder", undefined),
					ctx.mcpReq.signal,
				),
			),
	);
	server.registerTool(
		"create_folder",
		{
			description:
				"Create a folder with explicit workspaceId/name and caller UUID. Server assigns ID and append position. One request within 4 KiB without hidden reads, retries or rebase. Writes return immutable original acknowledgments, including replay after deletion/recreation, under current original-workspace write authority. Preserve identical ID/body/UUID for an uncertain manual retry.",
			inputSchema: guardedFolderInput(
				z
					.object({ requestId: z.uuid(), folder: apiFolderCreateSchema })
					.strict(),
				"create-folder",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiFolderCreateAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: false,
			},
		},
		(args, ctx) =>
			execute(() =>
				folderWorkflow(
					{
						...fixed,
						command: "create-folder",
						folderId: undefined,
						requestId: args.requestId.toLowerCase(),
					},
					fetcher,
					async () => encodeFolderWorkflowInput("create-folder", args.folder),
					ctx.mcpReq.signal,
				),
			),
	);
	server.registerTool(
		"update_folder",
		{
			description:
				"Rename only name using observed workspaceId and stateToken as expectedState with caller UUID. One request within 4 KiB without hidden reads, retries or rebase. Writes return immutable original acknowledgments, including replay after deletion/recreation, under current original-workspace write authority. Preserve identical ID/body/UUID for an uncertain manual retry.",
			inputSchema: guardedFolderInput(
				z
					.object({
						folderId: folderIdSchema,
						requestId: z.uuid(),
						folder: apiFolderUpdateSchema,
					})
					.strict(),
				"update-folder",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiFolderUpdateAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		(args, ctx) =>
			execute(() =>
				folderWorkflow(
					{
						...fixed,
						command: "update-folder",
						folderId: args.folderId,
						requestId: args.requestId.toLowerCase(),
					},
					fetcher,
					async () => encodeFolderWorkflowInput("update-folder", args.folder),
					ctx.mcpReq.signal,
				),
			),
	);
	server.registerTool(
		"delete_folder",
		{
			description:
				"Delete only an empty observed folder using workspaceId/expectedState and caller UUID. No cascade, reparenting or list/task deletion. One request within 4 KiB without hidden reads, retries or rebase. Writes return immutable original acknowledgments, including replay after deletion/recreation, under current original-workspace write authority. Preserve identical ID/body/UUID for an uncertain manual retry.",
			inputSchema: guardedFolderInput(
				z
					.object({
						folderId: folderIdSchema,
						requestId: z.uuid(),
						folder: apiFolderDeleteSchema,
					})
					.strict(),
				"delete-folder",
			),
			outputSchema: z
				.object({
					version: z.literal(1),
					data: apiFolderDeleteAckSchema,
					nextCursor: z.null(),
				})
				.strict(),
			annotations: {
				...annotations,
				readOnlyHint: false,
				destructiveHint: true,
			},
		},
		(args, ctx) =>
			execute(() =>
				folderWorkflow(
					{
						...fixed,
						command: "delete-folder",
						folderId: args.folderId,
						requestId: args.requestId.toLowerCase(),
					},
					fetcher,
					async () => encodeFolderWorkflowInput("delete-folder", args.folder),
					ctx.mcpReq.signal,
				),
			),
	);

	return server;
}
