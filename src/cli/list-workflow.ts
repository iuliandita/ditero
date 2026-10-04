import { z } from "zod";
import { PUBLIC_API_ID } from "../domain/public-api.ts";
import {
	apiListCreationAckSchema,
	parseApiListCreate,
} from "../domain/public-api-list-create.ts";
import {
	apiListDeleteAckSchema,
	apiListDeletionObservationSchema,
	parseApiListDelete,
} from "../domain/public-api-list-deletion.ts";
import {
	apiListObservationSchema,
	apiListUpdateAckSchema,
	parseApiListUpdate,
} from "../domain/public-api-list-update.ts";
import { parseApiIdempotencyKey } from "../domain/public-api-writes.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { type Fetcher, requestJson } from "./client.ts";
import { readStdin, type StdinReader } from "./task-workflow.ts";

export const MAX_LIST_INPUT_BYTES = 4096;
function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide one strict list JSON object within 4 KiB and the required list ID/request UUID.",
		2,
	);
}
export function safeListInput(value: unknown, depth = 0): boolean {
	if (
		depth > 4 ||
		value === undefined ||
		["function", "symbol", "bigint"].includes(typeof value)
	)
		return false;
	if (typeof value === "number" && !Number.isFinite(value)) return false;
	if (!value || typeof value !== "object") return true;
	if (Array.isArray(value) || Object.getOwnPropertySymbols(value).length)
		return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	return Object.entries(Object.getOwnPropertyDescriptors(value)).every(
		([key, descriptor]) =>
			!["__proto__", "constructor", "prototype"].includes(key) &&
			descriptor.enumerable &&
			"value" in descriptor &&
			descriptor.value !== undefined &&
			safeListInput(descriptor.value, depth + 1),
	);
}
export function encodeListInput(value: unknown): Uint8Array {
	if (!safeListInput(value)) invalidInput();
	let bytes: Uint8Array;
	try {
		bytes = new TextEncoder().encode(JSON.stringify(value));
	} catch {
		invalidInput();
	}
	if (!bytes.length || bytes.length > MAX_LIST_INPUT_BYTES) invalidInput();
	return bytes;
}
export function encodeListDeletionInput(value: unknown): Uint8Array {
	if (!safeListInput(value)) invalidInput();
	try {
		return encodeListInput(parseApiListDelete(value));
	} catch {
		invalidInput();
	}
}
export async function listWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readStdin,
	signal?: AbortSignal,
): Promise<unknown> {
	if (
		![
			"create-list",
			"observe-list",
			"update-list",
			"observe-list-deletion",
			"delete-list",
		].includes(options.command)
	)
		invalidInput();
	const deleting = options.command === "delete-list";
	const deletionObservation = options.command === "observe-list-deletion";
	const observing = options.command === "observe-list" || deletionObservation;
	const creating = options.command === "create-list";
	if (
		!creating &&
		(!PUBLIC_API_ID.safeParse(options.listId).success ||
			options.listId === "." ||
			options.listId === "..")
	)
		invalidInput();
	let body:
		| ReturnType<typeof parseApiListCreate>
		| ReturnType<typeof parseApiListUpdate>
		| ReturnType<typeof parseApiListDelete>
		| undefined;
	let requestId: string | undefined;
	if (!observing) {
		let raw: unknown;
		try {
			const bytes = await reader();
			if (!bytes.length || bytes.length > MAX_LIST_INPUT_BYTES) invalidInput();
			raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			if (!safeListInput(raw)) invalidInput();
			requestId = parseApiIdempotencyKey(options.requestId ?? null);
			body = creating
				? parseApiListCreate(raw)
				: deleting
					? parseApiListDelete(raw)
					: parseApiListUpdate(raw);
		} catch {
			invalidInput();
		}
	}
	const path = creating
		? "/api/v1/lists"
		: `/api/v1/lists/${encodeURIComponent(options.listId ?? "")}${deletionObservation ? "/deletion-observation" : observing ? "/observation" : ""}`;
	let result: unknown;
	try {
		result = await requestJson(
			options,
			new URL(path, options.server),
			fetcher,
			body && requestId
				? {
						body: new TextDecoder().decode(encodeListInput(body)),
						requestId,
						method: creating ? "POST" : deleting ? "DELETE" : "PATCH",
						allowCreated: creating,
					}
				: undefined,
			undefined,
			signal,
		);
	} catch (error) {
		if (error instanceof CliError && error.status === 409)
			throw new CliError(
				error.code,
				"The request conflicts with observed list state or an existing request ID. Preserve the exact UUID and body for an uncertain-outcome retry.",
				error.exitCode,
				error.status,
			);
		throw error;
	}
	const parsed = z
		.object({
			version: z.literal(1),
			data: observing
				? deletionObservation
					? apiListDeletionObservationSchema
					: apiListObservationSchema
				: creating
					? apiListCreationAckSchema
					: deleting
						? apiListDeleteAckSchema
						: apiListUpdateAckSchema,
			nextCursor: z.null(),
		})
		.strict()
		.safeParse(result);
	if (!parsed.success)
		throw new CliError(
			"invalid_response",
			"The server returned an invalid list response.",
			8,
		);
	const snapshot = parsed.data.data.snapshot;
	if (
		(!creating && snapshot.id !== options.listId) ||
		(body && snapshot.workspaceId !== body.workspaceId)
	)
		throw new CliError(
			"invalid_response",
			"The server returned a mismatched list response.",
			8,
		);
	if (
		deleting &&
		body &&
		"expectedTasksState" in body &&
		(!("deletedTasks" in parsed.data.data) ||
			parsed.data.data.deletedTasks !== body.expectedTasksState.count)
	)
		throw new CliError(
			"invalid_response",
			"The server returned a mismatched deletion count.",
			8,
		);
	return parsed.data;
}
