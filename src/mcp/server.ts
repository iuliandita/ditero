import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CliError, type CliOptions, parseArguments } from "../cli/arguments.ts";
import { discover, type Fetcher } from "../cli/client.ts";
import { PUBLIC_API_ID, PUBLIC_API_PAGE_SIZE } from "../domain/public-api.ts";
import {
	PUBLIC_API_RESOURCES,
	publicApiProfileSchema,
	publicApiResourceSchemas,
} from "../domain/public-api-resources.ts";

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
		{ name: "ditero", version: "1.0.0" },
		{ capabilities: { tools: {} }, maxToolInputElements: 16 },
	);
	let active = 0;
	async function read(
		command: CliOptions["command"],
		args: {
			limit?: number;
			cursor?: string;
			workspaceId?: string;
			listId?: string;
			done?: boolean;
		},
	) {
		try {
			if (active >= 4)
				throw new CliError(
					"busy",
					"Four reads are already running. Try again shortly.",
					6,
					429,
				);
			active++;
			try {
				const result = await discover(
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
				);
				const output = {
					version: result.version,
					data: result.data,
					nextCursor: result.nextCursor,
				};
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
							"The read could not be completed.",
							9,
						);
			const output = {
				version: 1,
				error: {
					code: failure.code,
					status: failure.status,
					message: failure.message,
				},
			};
			return {
				isError: true,
				content: [{ type: "text" as const, text: JSON.stringify(output) }],
				structuredContent: output,
			};
		}
	}
	server.registerTool(
		"get_profile",
		{
			description:
				"Read the configured account's profile, timezone choice, locale, and token access.",
			inputSchema: z.object({}).strict(),
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
				inputSchema: resource === "tasks" ? taskInput : pageInput,
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
	return server;
}
