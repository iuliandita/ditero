import {
	McpServer,
	type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { taskIntentSchema } from "../agent/task-plan.ts";
import { CliError, type CliOptions, parseArguments } from "../cli/arguments.ts";
import { discover, type Fetcher } from "../cli/client.ts";
import { taskWorkflow } from "../cli/task-workflow.ts";
import { clientBuild } from "../clients/build-info.ts";
import { PUBLIC_API_ID, PUBLIC_API_PAGE_SIZE } from "../domain/public-api.ts";
import { apiTaskCompleteSchema } from "../domain/public-api-completion.ts";
import {
	PUBLIC_API_RESOURCES,
	publicApiProfileSchema,
	publicApiResourceSchemas,
} from "../domain/public-api-resources.ts";
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
): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
	const standard = schema["~standard"];
	return {
		"~standard": {
			...standard,
			validate: async (value) => {
				const invalid = {
					issues: [{ message: "Invalid or oversized tool arguments." }],
				};
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
		command: "plan-task" | "create-task" | "complete-task",
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
	return server;
}
