import { z } from "zod";
import {
	API_COMMENT_RESPONSE_BYTES,
	type ApiCommentInput,
	type ApiCommentOperation,
	apiCommentAckSchema,
	apiCommentIdSchema,
	apiCommentObservationSchema,
	apiCommentSnapshotSchema,
	parseApiCommentCreate,
	parseApiCommentDelete,
	parseApiCommentUpdate,
	parseCommentPageQuery,
} from "../domain/public-api-comments.ts";
import { parseApiIdempotencyKey } from "../domain/public-api-writes.ts";
import { CliError, type CliOptions } from "./arguments.ts";
import { type Fetcher, requestJson } from "./client.ts";
import { readStdin, type StdinReader } from "./task-workflow.ts";

export const COMMENT_COMMANDS = [
	"list-task-comments",
	"observe-comment",
	"add-comment",
	"edit-comment",
	"delete-comment",
] as const;
function invalidInput(): never {
	throw new CliError(
		"invalid_input",
		"Provide explicit task/comment IDs, a request UUID for writes and strict observed comment JSON within its transport limit.",
		2,
	);
}
function invalidResponse(): never {
	throw new CliError(
		"invalid_response",
		"The server returned an invalid or mismatched comment response.",
		8,
	);
}
export function encodeCommentInput(
	operation: ApiCommentOperation,
	value: unknown,
): Uint8Array {
	try {
		const parsed =
			operation === "create"
				? parseApiCommentCreate(value)
				: operation === "update"
					? parseApiCommentUpdate(value)
					: parseApiCommentDelete(value);
		const bytes = new TextEncoder().encode(JSON.stringify(parsed));
		if (!bytes.length || bytes.length > (operation === "delete" ? 4096 : 65536))
			invalidInput();
		return bytes;
	} catch {
		invalidInput();
	}
}
export async function commentWorkflow(
	options: CliOptions,
	fetcher: Fetcher = fetch,
	reader: StdinReader = readStdin,
	signal?: AbortSignal,
): Promise<unknown> {
	if (
		!COMMENT_COMMANDS.some((command) => command === options.command) ||
		!apiCommentIdSchema.safeParse(options.taskId).success ||
		options.all ||
		options.workspaceId !== undefined ||
		options.listId !== undefined ||
		options.done !== undefined
	)
		invalidInput();
	const listing = options.command === "list-task-comments",
		observing = options.command === "observe-comment";
	const operation =
		options.command === "add-comment"
			? "create"
			: options.command === "edit-comment"
				? "update"
				: "delete";
	if ((listing || operation === "create") && options.commentId !== undefined)
		invalidInput();
	if (
		!listing &&
		(observing || operation !== "create") &&
		!apiCommentIdSchema.safeParse(options.commentId).success
	)
		invalidInput();
	if (!listing && options.cursor !== undefined) invalidInput();
	const url = new URL(
		`/api/v1/tasks/${encodeURIComponent(options.taskId ?? "")}/comments${options.commentId === undefined ? "" : `/${encodeURIComponent(options.commentId)}`}${observing ? "/observation" : ""}`,
		options.server,
	);
	let body: ApiCommentInput | undefined, requestId: string | undefined;
	let page: ReturnType<typeof parseCommentPageQuery> | undefined;
	try {
		if (listing) {
			url.searchParams.set("limit", String(options.limit));
			if (options.cursor !== undefined)
				url.searchParams.set("cursor", options.cursor);
			page = parseCommentPageQuery(url, options.taskId ?? "");
		}
		if (listing || observing) {
			if (options.requestId !== undefined) invalidInput();
		} else {
			requestId = parseApiIdempotencyKey(options.requestId ?? null);
			const bytes = await reader();
			if (
				!bytes.length ||
				bytes.length > (operation === "delete" ? 4096 : 65536)
			)
				invalidInput();
			const raw: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(bytes),
			);
			const encoded = encodeCommentInput(operation, raw);
			body = JSON.parse(new TextDecoder().decode(encoded)) as ApiCommentInput;
		}
	} catch {
		invalidInput();
	}
	let result: unknown;
	try {
		result = await requestJson(
			options,
			url,
			fetcher,
			body
				? {
						method:
							operation === "create"
								? "POST"
								: operation === "update"
									? "PATCH"
									: "DELETE",
						body: new TextDecoder().decode(encodeCommentInput(operation, body)),
						requestId: requestId ?? invalidInput(),
						allowCreated: false,
					}
				: undefined,
			undefined,
			signal,
			API_COMMENT_RESPONSE_BYTES,
		);
	} catch (error) {
		if (error instanceof CliError && error.status === 409)
			throw new CliError(
				error.code,
				"Comment state or request UUID conflicts. After uncertain transport, manually retry the identical task/comment IDs, JSON body and UUID without replacing observation state.",
				error.exitCode,
				error.status,
			);
		throw error;
	}
	if (listing) {
		const parsed = z
			.object({
				version: z.literal(1),
				data: z.array(apiCommentSnapshotSchema).max(options.limit),
				nextCursor: z.string().nullable(),
			})
			.strict()
			.safeParse(result);
		if (!parsed.success) invalidResponse();
		let previous = page?.after ?? null;
		for (const snapshot of parsed.data.data) {
			if (
				snapshot.taskId !== options.taskId ||
				(previous !== null &&
					Buffer.compare(
						Buffer.from(snapshot.commentId),
						Buffer.from(previous),
					) <= 0)
			)
				invalidResponse();
			previous = snapshot.commentId;
		}
		if (parsed.data.nextCursor !== null) {
			try {
				const next = new URL(url);
				next.searchParams.set("cursor", parsed.data.nextCursor);
				if (
					!parsed.data.data.length ||
					parseCommentPageQuery(next, options.taskId ?? "").after !== previous
				)
					invalidResponse();
			} catch {
				invalidResponse();
			}
		}
		return parsed.data;
	}
	const parsed = z
		.object({
			version: z.literal(1),
			data: observing ? apiCommentObservationSchema : apiCommentAckSchema,
			nextCursor: z.null(),
		})
		.strict()
		.safeParse(result);
	if (!parsed.success) invalidResponse();
	const data = parsed.data.data,
		snapshot = data.snapshot;
	if (
		snapshot.taskId !== options.taskId ||
		(options.commentId !== undefined &&
			snapshot.commentId !== options.commentId)
	)
		invalidResponse();
	if (
		body &&
		(!("kind" in data) ||
			data.kind !== `comment-${operation}-ack` ||
			snapshot.workspaceId !== body.workspaceId ||
			snapshot.listId !== body.listId ||
			("body" in body && snapshot.body !== body.body))
	)
		invalidResponse();
	return parsed.data;
}
