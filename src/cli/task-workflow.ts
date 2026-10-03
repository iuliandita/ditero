import { z } from "zod";
import {
	planTask,
	TaskPlanError,
	taskIntentSchema,
} from "../agent/task-plan.ts";
import { PUBLIC_API_ID } from "../domain/public-api.ts";
import { apiTaskCompleteSchema } from "../domain/public-api-completion.ts";
import { publicApiResourceSchemas } from "../domain/public-api-resources.ts";
import { apiTaskCreateSchema } from "../domain/public-api-writes.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { discover, type Fetcher, requestJson } from "./client.ts";

export const MAX_INPUT_BYTES = 65_536;
export type StdinReader = () => Promise<Uint8Array>;
function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide one valid JSON object on stdin, at most 64 KiB, with only supported fields.",
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
async function input(reader: StdinReader): Promise<unknown> {
	let bytes: Uint8Array;
	try {
		bytes = await reader();
	} catch {
		invalidInput();
	}
	if (!bytes.length || bytes.length > MAX_INPUT_BYTES) invalidInput();
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		invalidInput();
	}
	safeInput(raw);
	return raw;
}
export async function taskWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readStdin,
	callerSignal?: AbortSignal,
): Promise<unknown> {
	const raw = await input(reader);
	if (
		options.command === "create-task" ||
		options.command === "complete-task"
	) {
		const completing = options.command === "complete-task";
		const parsed = completing
			? apiTaskCompleteSchema.safeParse(raw)
			: apiTaskCreateSchema.safeParse(raw);
		if (!parsed.success || !options.requestId) invalidInput();
		if (completing && !PUBLIC_API_ID.safeParse(options.taskId).success)
			invalidInput();
		const result = await requestJson(
			options,
			new URL(
				completing
					? `/api/v1/tasks/${encodeURIComponent(options.taskId ?? "")}/complete`
					: "/api/v1/tasks",
				options.server,
			),
			fetcher,
			{ body: JSON.stringify(parsed.data), requestId: options.requestId },
			undefined,
			callerSignal,
		);
		const validated = z
			.object({
				version: z.literal(1),
				data: publicApiResourceSchemas.tasks,
				nextCursor: z.null(),
			})
			.strict()
			.safeParse(result);
		if (!validated.success)
			throw new CliError(
				"invalid_response",
				"The server returned an invalid task response.",
				8,
			);
		return validated.data;
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
