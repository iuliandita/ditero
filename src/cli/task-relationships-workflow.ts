import { z } from "zod";
import {
	apiTaskRelationshipObservationSchema,
	apiTaskRelationshipSnapshotSchema,
	apiTaskRelationshipsAckSchema,
	parseApiTaskRelationships,
} from "../domain/public-api-task-relationships.ts";
import { parseApiIdempotencyKey } from "../domain/public-api-writes.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { type Fetcher, requestJson } from "./client.ts";
import { readStdin, type StdinReader } from "./task-workflow.ts";

export const MAX_RELATIONSHIP_INPUT_BYTES = 65_536;
function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide the explicit task ID, request UUID and one strict relationship JSON body within 64 KiB.",
		2,
	);
}
export function safeRelationshipObject(
	value: unknown,
	fields: readonly string[],
): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const keys = Reflect.ownKeys(value);
	if (
		keys.length > fields.length ||
		keys.some((key) => typeof key !== "string" || !fields.includes(key))
	)
		return false;
	return Object.values(Object.getOwnPropertyDescriptors(value)).every(
		(descriptor) =>
			descriptor.enumerable &&
			"value" in descriptor &&
			descriptor.value !== undefined,
	);
}
function safeIds(value: unknown, maximum: number): boolean {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		return false;
	const length: unknown = Object.getOwnPropertyDescriptor(
		value,
		"length",
	)?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > maximum
	)
		return false;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1) return false;
	return keys.every((key) => {
		if (key === "length") return true;
		if (
			typeof key !== "string" ||
			!/^(0|[1-9][0-9]*)$/.test(key) ||
			Number(key) >= length
		)
			return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return Boolean(
			descriptor?.enumerable &&
				"value" in descriptor &&
				typeof descriptor.value === "string",
		);
	});
}
export function safeTaskRelationshipsInput(value: unknown): boolean {
	return (
		safeRelationshipObject(value, [
			"workspaceId",
			"listId",
			"expectedState",
			"assigneeIds",
			"labelIds",
		]) &&
		safeIds(value.assigneeIds, 20) &&
		safeIds(value.labelIds, 50)
	);
}
export function encodeTaskRelationshipsInput(value: unknown): Uint8Array {
	try {
		if (!safeTaskRelationshipsInput(value)) invalidInput();
		const bytes = new TextEncoder().encode(
			JSON.stringify(parseApiTaskRelationships(value)),
		);
		if (!bytes.length || bytes.length > MAX_RELATIONSHIP_INPUT_BYTES)
			invalidInput();
		return bytes;
	} catch {
		invalidInput();
	}
}
export async function taskRelationshipsWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readStdin,
	signal?: AbortSignal,
): Promise<unknown> {
	if (
		!["observe-task-relationships", "update-task-relationships"].includes(
			options.command,
		) ||
		!apiTaskRelationshipSnapshotSchema.shape.taskId.safeParse(options.taskId)
			.success ||
		options.taskId === "." ||
		options.taskId === ".."
	)
		invalidInput();
	const observing = options.command === "observe-task-relationships";
	let body: ReturnType<typeof parseApiTaskRelationships> | undefined;
	let requestId: string | undefined;
	if (!observing) {
		try {
			const bytes = await reader();
			if (!bytes.length || bytes.length > MAX_RELATIONSHIP_INPUT_BYTES)
				invalidInput();
			const raw: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
			if (!safeTaskRelationshipsInput(raw)) invalidInput();
			body = parseApiTaskRelationships(raw);
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
				`/api/v1/tasks/${encodeURIComponent(options.taskId ?? "")}/relationships`,
				options.server,
			),
			fetcher,
			body
				? {
						method: "PATCH",
						body: new TextDecoder().decode(encodeTaskRelationshipsInput(body)),
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
				"Relationship state or request UUID conflicts. Preserve the identical task ID, body and UUID for an uncertain manual retry; do not substitute a new observation.",
				error.exitCode,
				error.status,
			);
		throw error;
	}
	const parsed = z
		.object({
			version: z.literal(1),
			data: observing
				? apiTaskRelationshipObservationSchema
				: apiTaskRelationshipsAckSchema,
			nextCursor: z.null(),
		})
		.strict()
		.safeParse(result);
	if (!parsed.success)
		throw new CliError(
			"invalid_response",
			"The server returned an invalid relationship response.",
			8,
		);
	const snapshot = parsed.data.data.snapshot;
	const same = (actual: string[], expected: string[]) =>
		actual.length === expected.length &&
		actual.every((id, index) => id === expected[index]);
	if (
		snapshot.taskId !== options.taskId ||
		(body &&
			(snapshot.listId !== body.listId ||
				snapshot.workspaceId !== body.workspaceId ||
				!same(snapshot.assigneeIds, body.assigneeIds) ||
				!same(snapshot.labelIds, body.labelIds)))
	)
		throw new CliError(
			"invalid_response",
			"The server returned a mismatched relationship acknowledgement.",
			8,
		);
	return parsed.data;
}
