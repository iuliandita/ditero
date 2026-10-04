import { z } from "zod";
import {
	apiTaskPlacementAckSchema,
	apiTaskPlacementObservationSchema,
	apiTaskPlacementSnapshotSchema,
	parseApiTaskPlacement,
} from "../domain/public-api-task-placement.ts";
import { parseApiIdempotencyKey } from "../domain/public-api-writes.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { type Fetcher, requestJson } from "./client.ts";
import { readStdin, type StdinReader } from "./task-workflow.ts";

export const MAX_PLACEMENT_INPUT_BYTES = 4096;
function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide the explicit task ID, request UUID and one strict placement JSON body within 4 KiB.",
		2,
	);
}
export function encodeTaskPlacementInput(value: unknown): Uint8Array {
	try {
		const bytes = new TextEncoder().encode(
			JSON.stringify(parseApiTaskPlacement(value)),
		);
		if (!bytes.length || bytes.length > MAX_PLACEMENT_INPUT_BYTES)
			invalidInput();
		return bytes;
	} catch {
		invalidInput();
	}
}
export async function taskPlacementWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readStdin,
	signal?: AbortSignal,
): Promise<unknown> {
	if (
		!["observe-task-placement", "place-task"].includes(options.command) ||
		!apiTaskPlacementSnapshotSchema.shape.task.shape.taskId.safeParse(
			options.taskId,
		).success ||
		options.taskId === "." ||
		options.taskId === ".." ||
		/[\uD800-\uDFFF]/u.test(options.taskId ?? "")
	)
		invalidInput();
	const observing = options.command === "observe-task-placement";
	let body: ReturnType<typeof parseApiTaskPlacement> | undefined;
	let requestId: string | undefined;
	if (!observing) {
		try {
			const bytes = await reader();
			if (!bytes.length || bytes.length > MAX_PLACEMENT_INPUT_BYTES)
				invalidInput();
			const raw: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
			body = parseApiTaskPlacement(raw);
			requestId = parseApiIdempotencyKey(options.requestId ?? null);
		} catch {
			invalidInput();
		}
	}
	let result: unknown;
	try {
		result = await requestJson(
			options,
			new URL(
				`/api/v1/tasks/${encodeURIComponent(options.taskId ?? "")}/${observing ? "placement-observation" : "placement"}`,
				options.server,
			),
			fetcher,
			body
				? {
						method: "PATCH",
						body: new TextDecoder().decode(encodeTaskPlacementInput(body)),
						requestId: requestId ?? invalidInput(),
					}
				: undefined,
			undefined,
			signal,
		);
	} catch (error) {
		if (error instanceof CliError && error.status === 409)
			throw new CliError(
				error.code,
				"Placement state or request UUID conflicts. Preserve the identical task ID, body and UUID for an uncertain manual retry; do not substitute a new observation.",
				error.exitCode,
				error.status,
			);
		throw error;
	}
	const parsed = z
		.object({
			version: z.literal(1),
			data: observing
				? apiTaskPlacementObservationSchema
				: apiTaskPlacementAckSchema,
			nextCursor: z.null(),
		})
		.strict()
		.safeParse(result);
	if (!parsed.success)
		throw new CliError(
			"invalid_response",
			"The server returned an invalid placement response.",
			8,
		);
	const snapshot = parsed.data.data.snapshot;
	if (
		snapshot.task.taskId !== options.taskId ||
		(body &&
			(snapshot.task.listId !== body.targetListId ||
				snapshot.task.workspaceId !== body.workspaceId ||
				snapshot.sortKey !== body.sortKey ||
				!("originalListId" in parsed.data.data) ||
				parsed.data.data.originalListId !== body.listId ||
				parsed.data.data.originalWorkspaceId !== body.workspaceId ||
				parsed.data.data.movedChildren !==
					(body.expectedChildrenState?.count ?? 0)))
	)
		throw new CliError(
			"invalid_response",
			"The server returned a mismatched placement acknowledgement.",
			8,
		);
	return parsed.data;
}
