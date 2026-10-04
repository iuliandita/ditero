import { z } from "zod";
import {
	planTask,
	TaskPlanError,
	taskIntentSchema,
} from "../agent/task-plan.ts";
import { PUBLIC_API_ID } from "../domain/public-api.ts";
import { apiTaskCompleteSchema } from "../domain/public-api-completion.ts";
import { publicApiResourceSchemas } from "../domain/public-api-resources.ts";
import {
	apiTaskDeletedSchema,
	apiTaskDeletionObservationSchema,
	parseApiTaskDelete,
} from "../domain/public-api-task-deletion.ts";
import {
	apiTaskObservationSchema,
	parseApiTaskUpdate,
} from "../domain/public-api-task-update.ts";
import { apiTaskCreateSchema } from "../domain/public-api-writes.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { discover, type Fetcher, requestJson } from "./client.ts";

export const MAX_INPUT_BYTES = 65_536;
export const MAX_DELETE_INPUT_BYTES = 4096;
export type StdinReader = () => Promise<Uint8Array>;
function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide one valid JSON object on stdin, within the command size limit, with only supported fields.",
		2,
	);
}
function safeInput(value: unknown, depth = 0): void {
	if (depth > 32) invalidInput();
	if (!value || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		if (["__proto__", "constructor", "prototype"].includes(key)) invalidInput();
		safeInput(child, depth + 1);
	}
}
export async function readStdin(): Promise<Uint8Array> {
	if (process.stdin.isTTY) invalidInput();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for await (const chunk of process.stdin) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > MAX_INPUT_BYTES) {
				process.stdin.destroy();
				invalidInput();
			}
			chunks.push(bytes);
		}
	} catch (error) {
		if (error instanceof CliError) throw error;
		invalidInput();
	}
	return Buffer.concat(chunks, size);
}
async function input(
	reader: StdinReader,
	limit = MAX_INPUT_BYTES,
): Promise<unknown> {
	let bytes: Uint8Array;
	try {
		bytes = await reader();
	} catch {
		invalidInput();
	}
	if (!bytes.length || bytes.length > limit) invalidInput();
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		invalidInput();
	}
	safeInput(raw);
	return raw;
}
function validatedTaskResponse(result: unknown, schema: z.ZodType): unknown {
	const parsed = z
		.object({ version: z.literal(1), data: schema, nextCursor: z.null() })
		.strict()
		.safeParse(result);
	if (!parsed.success)
		throw new CliError(
			"invalid_response",
			"The server returned an invalid task response.",
			8,
		);
	return parsed.data;
}
export async function taskWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readStdin,
	callerSignal?: AbortSignal,
): Promise<unknown> {
	const observing =
		options.command === "observe-task" ||
		options.command === "observe-task-deletion";
	if (
		observing ||
		options.command === "update-task" ||
		options.command === "delete-task"
	) {
		if (!PUBLIC_API_ID.safeParse(options.taskId).success) invalidInput();
	}
	if (observing) {
		const deletion = options.command === "observe-task-deletion";
		const result = await requestJson(
			options,
			new URL(
				`/api/v1/tasks/${encodeURIComponent(options.taskId ?? "")}/${deletion ? "deletion-observation" : "observation"}`,
				options.server,
			),
			fetcher,
			undefined,
			undefined,
			callerSignal,
		);
		return validatedTaskResponse(
			result,
			deletion ? apiTaskDeletionObservationSchema : apiTaskObservationSchema,
		);
	}
	const raw = await input(
		reader,
		options.command === "delete-task"
			? MAX_DELETE_INPUT_BYTES
			: MAX_INPUT_BYTES,
	);
	if (
		["create-task", "complete-task", "update-task", "delete-task"].includes(
			options.command,
		)
	) {
		if (!options.requestId) invalidInput();
		let body: unknown;
		try {
			if (options.command === "update-task") body = parseApiTaskUpdate(raw);
			else if (options.command === "delete-task")
				body = parseApiTaskDelete(raw);
			else
				body = (
					options.command === "complete-task"
						? apiTaskCompleteSchema
						: apiTaskCreateSchema
				).parse(raw);
		} catch {
			invalidInput();
		}
		if (
			options.command !== "create-task" &&
			!PUBLIC_API_ID.safeParse(options.taskId).success
		)
			invalidInput();
		const method =
			options.command === "update-task"
				? "PATCH"
				: options.command === "delete-task"
					? "DELETE"
					: "POST";
		const path =
			options.command === "create-task"
				? "/api/v1/tasks"
				: `/api/v1/tasks/${encodeURIComponent(options.taskId ?? "")}${options.command === "complete-task" ? "/complete" : ""}`;
		const result = await requestJson(
			options,
			new URL(path, options.server),
			fetcher,
			{
				body: JSON.stringify(body),
				requestId: options.requestId,
				method,
				allowCreated: options.command === "create-task",
			},
			undefined,
			callerSignal,
		);
		return validatedTaskResponse(
			result,
			options.command === "delete-task"
				? apiTaskDeletedSchema
				: publicApiResourceSchemas.tasks,
		);
	}

	const intent = taskIntentSchema.safeParse(raw);
	if (!intent.success) invalidInput();
	const budget = { bytes: 0 };
	const base = {
		...options,
		all: true,
		limit: 100,
		cursor: undefined,
		workspaceId: undefined,
		listId: undefined,
		done: undefined,
	};
	const profile = (
		await discover(
			{ ...base, command: "profile" },
			fetcher,
			budget,
			callerSignal,
		)
	).data;
	const snapshot: Record<string, unknown> = { profile };
	for (const command of [
		"workspaces",
		"lists",
		"people",
		"labels",
		"views",
		"dashboards",
	] as const) {
		snapshot[command] = (
			await discover({ ...base, command }, fetcher, budget, callerSignal)
		).data;
	}
	try {
		return planTask(intent.data, snapshot);
	} catch (error) {
		if (error instanceof TaskPlanError)
			throw new CliError(
				error.code,
				error.message,
				error.code === "write-token-required" ? 4 : 2,
				null,
				error.choices,
			);
		invalidInput();
	}
}
