import { z } from "zod";
import { PUBLIC_API_ID } from "../domain/public-api.ts";
import {
	apiFolderCreateAckSchema,
	apiFolderDeleteAckSchema,
	apiFolderObservationSchema,
	apiFolderUpdateAckSchema,
	parseApiFolderCreate,
	parseApiFolderDelete,
	parseApiFolderUpdate,
} from "../domain/public-api-folder.ts";
import { parseApiIdempotencyKey } from "../domain/public-api-writes.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { type Fetcher, requestJson } from "./client.ts";
import { safeListInput } from "./list-workflow.ts";
import type { StdinReader } from "./task-workflow.ts";

export const MAX_FOLDER_INPUT_BYTES = 4096;
function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide one strict folder JSON object within 4 KiB and the required folder ID/request UUID.",
		2,
	);
}
export function encodeFolderInput(value: unknown): Uint8Array {
	if (!safeListInput(value)) invalidInput();
	let bytes: Uint8Array;
	try {
		bytes = new TextEncoder().encode(JSON.stringify(value));
	} catch {
		invalidInput();
	}
	if (!bytes.length || bytes.length > MAX_FOLDER_INPUT_BYTES) invalidInput();
	return bytes;
}
export const FOLDER_COMMANDS = [
	"observe-folder",
	"create-folder",
	"update-folder",
	"delete-folder",
] as const;
export function encodeFolderWorkflowInput(
	command: CliOptions["command"],
	value: unknown,
): Uint8Array {
	encodeFolderInput(value);
	try {
		return encodeFolderInput(
			command === "create-folder"
				? parseApiFolderCreate(value)
				: command === "update-folder"
					? parseApiFolderUpdate(value)
					: command === "delete-folder"
						? parseApiFolderDelete(value)
						: invalidInput(),
		);
	} catch {
		invalidInput();
	}
}
async function readFolderStdin(): Promise<Uint8Array> {
	if (process.stdin.isTTY) invalidInput();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for await (const chunk of process.stdin) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > MAX_FOLDER_INPUT_BYTES) {
				process.stdin.destroy();
				invalidInput();
			}
			chunks.push(bytes);
		}
	} catch {
		invalidInput();
	}
	return Buffer.concat(chunks, size);
}
export async function folderWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readFolderStdin,
	signal?: AbortSignal,
): Promise<unknown> {
	if (
		![
			"create-folder",
			"observe-folder",
			"update-folder",
			"delete-folder",
		].includes(options.command)
	)
		invalidInput();
	const deleting = options.command === "delete-folder";
	const observing = options.command === "observe-folder";
	const creating = options.command === "create-folder";
	if (
		!creating &&
		(!PUBLIC_API_ID.safeParse(options.folderId).success ||
			options.folderId === "." ||
			options.folderId === ".." ||
			/[\uD800-\uDFFF]/u.test(options.folderId ?? "") ||
			(options.folderId ?? "").includes("\0"))
	)
		invalidInput();
	let body:
		| ReturnType<typeof parseApiFolderCreate>
		| ReturnType<typeof parseApiFolderUpdate>
		| ReturnType<typeof parseApiFolderDelete>
		| undefined;
	let requestId: string | undefined;
	if (!observing) {
		let raw: unknown;
		try {
			const bytes = await reader();
			if (!bytes.length || bytes.length > MAX_FOLDER_INPUT_BYTES)
				invalidInput();
			raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
			if (!safeListInput(raw)) invalidInput();
			requestId = parseApiIdempotencyKey(options.requestId ?? null);
			body = creating
				? parseApiFolderCreate(raw)
				: deleting
					? parseApiFolderDelete(raw)
					: parseApiFolderUpdate(raw);
		} catch {
			invalidInput();
		}
	}
	const path = creating
		? "/api/v1/folders"
		: `/api/v1/folders/${encodeURIComponent(options.folderId ?? "")}${observing ? "/observation" : ""}`;
	let result: unknown;
	try {
		result = await requestJson(
			options,
			new URL(path, options.server),
			fetcher,
			body && requestId
				? {
						body: new TextDecoder().decode(encodeFolderInput(body)),
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
				"The request conflicts with observed folder state or an existing request ID. Preserve the exact UUID and body for an uncertain-outcome retry.",
				error.exitCode,
				error.status,
			);
		throw error;
	}
	const parsed = z
		.object({
			version: z.literal(1),
			data: observing
				? apiFolderObservationSchema
				: creating
					? apiFolderCreateAckSchema
					: deleting
						? apiFolderDeleteAckSchema
						: apiFolderUpdateAckSchema,
			nextCursor: z.null(),
		})
		.strict()
		.safeParse(result);
	if (!parsed.success)
		throw new CliError(
			"invalid_response",
			"The server returned an invalid folder response.",
			8,
		);
	const snapshot = parsed.data.data.snapshot;
	if (
		(!creating && snapshot.id !== options.folderId) ||
		(body && snapshot.workspaceId !== body.workspaceId) ||
		(body && "name" in body && snapshot.name !== body.name) ||
		(body && "patch" in body && snapshot.name !== body.patch.name)
	)
		throw new CliError(
			"invalid_response",
			"The server returned a mismatched folder response.",
			8,
		);
	return parsed.data;
}
