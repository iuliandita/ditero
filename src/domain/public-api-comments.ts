import { z } from "zod";
import { PublicApiError } from "./public-api.ts";

export const API_COMMENT_RESPONSE_BYTES = 262144;
const text = z
	.string()
	.refine((value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
export const apiCommentIdSchema = text
	.min(1)
	.max(256)
	.refine(
		(value) =>
			!Array.from(value).some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			) && !value.split("/").some((part) => part === "." || part === ".."),
	);
const state = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const scope = { workspaceId: apiCommentIdSchema, listId: apiCommentIdSchema };
export const apiCommentCreateSchema = z
	.object({ ...scope, expectedTaskState: state, body: text.max(10000) })
	.strict();
export const apiCommentUpdateSchema = z
	.object({ ...scope, expectedState: state, body: text })
	.strict();
export const apiCommentDeleteSchema = z
	.object({
		...scope,
		expectedState: state,
		deleteScope: z.literal("comment-and-attachments"),
	})
	.strict();
const metadata = {
	version: z.literal(1),
	commentId: apiCommentIdSchema,
	taskId: apiCommentIdSchema,
	...scope,
	authorId: apiCommentIdSchema.nullable(),
	createdAt: instant,
	editedAt: instant.nullable(),
	historicalAuthorKind: z.enum(["source_claim", "unknown"]).nullable(),
	historicalAuthorName: text.max(512).nullable(),
	importedAt: instant.nullable(),
	provenanceRedactedAt: instant.nullable(),
};
export const apiCommentSnapshotSchema = z
	.object({ ...metadata, body: text })
	.strict();
export const apiCommentBodyEvidenceSchema = z
	.object({
		sha256: state,
		utf8Bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
	})
	.strict();
export const apiCommentCompactSnapshotSchema = z
	.object({ ...metadata, body: apiCommentBodyEvidenceSchema })
	.strict();
export const apiCommentObservationSchema = z
	.object({ snapshot: apiCommentCompactSnapshotSchema, stateToken: state })
	.strict();
const ack = {
	originalWorkspaceId: apiCommentIdSchema,
	originalListId: apiCommentIdSchema,
	originalTaskId: apiCommentIdSchema,
};
export const apiCommentAckSchema = z
	.discriminatedUnion("kind", [
		z
			.object({
				kind: z.literal("comment-create-ack"),
				...ack,
				snapshot: apiCommentSnapshotSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal("comment-update-ack"),
				...ack,
				snapshot: apiCommentSnapshotSchema,
			})
			.strict(),
		z
			.object({
				kind: z.literal("comment-delete-ack"),
				...ack,
				snapshot: apiCommentCompactSnapshotSchema,
				deleted: z.literal(true),
			})
			.strict(),
	])
	.refine(
		(value) =>
			value.originalWorkspaceId === value.snapshot.workspaceId &&
			value.originalListId === value.snapshot.listId &&
			value.originalTaskId === value.snapshot.taskId,
	);
export type ApiCommentSnapshot = z.infer<typeof apiCommentSnapshotSchema>;
export type ApiCommentCreate = z.infer<typeof apiCommentCreateSchema>;
export type ApiCommentUpdate = z.infer<typeof apiCommentUpdateSchema>;
export type ApiCommentDelete = z.infer<typeof apiCommentDeleteSchema>;
export type ApiCommentInput =
	| ApiCommentCreate
	| ApiCommentUpdate
	| ApiCommentDelete;
export type ApiCommentOperation = "create" | "update" | "delete";
export type ApiCommentAck = z.infer<typeof apiCommentAckSchema>;

function ownFields(value: unknown, allowed: readonly string[]): unknown {
	if (
		!value ||
		typeof value !== "object" ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
		Object.getOwnPropertySymbols(value).length
	)
		throw invalid();
	const fields = Object.getOwnPropertyDescriptors(value);
	for (const [key, field] of Object.entries(fields))
		if (
			!allowed.includes(key) ||
			!field.enumerable ||
			!("value" in field) ||
			field.value === undefined
		)
			throw invalid();
	return value;
}
const invalid = () =>
	new PublicApiError(400, "invalid-comment", "Invalid comment request");
export function parseApiCommentCreate(value: unknown): ApiCommentCreate {
	const parsed = apiCommentCreateSchema.safeParse(
		ownFields(value, ["workspaceId", "listId", "expectedTaskState", "body"]),
	);
	if (!parsed.success) throw invalid();
	return parsed.data;
}
export function parseApiCommentUpdate(value: unknown): ApiCommentUpdate {
	const parsed = apiCommentUpdateSchema.safeParse(
		ownFields(value, ["workspaceId", "listId", "expectedState", "body"]),
	);
	if (!parsed.success) throw invalid();
	return parsed.data;
}
export function parseApiCommentDelete(value: unknown): ApiCommentDelete {
	const parsed = apiCommentDeleteSchema.safeParse(
		ownFields(value, ["workspaceId", "listId", "expectedState", "deleteScope"]),
	);
	if (!parsed.success) throw invalid();
	return parsed.data;
}
export function canonicalApiCommentRequest(
	operation: ApiCommentOperation,
	taskId: string,
	commentId: string | null,
	input: ApiCommentInput,
): string {
	return JSON.stringify([
		"comment-request",
		1,
		operation,
		taskId,
		commentId,
		input.workspaceId,
		input.listId,
		"expectedTaskState" in input
			? input.expectedTaskState
			: input.expectedState,
		"body" in input ? input.body : input.deleteScope,
	]);
}
export function canonicalApiCommentSnapshot(
	snapshot: ApiCommentSnapshot,
): string {
	return JSON.stringify([
		"comment-snapshot",
		1,
		snapshot.commentId,
		snapshot.taskId,
		snapshot.listId,
		snapshot.workspaceId,
		snapshot.authorId,
		snapshot.body,
		snapshot.createdAt,
		snapshot.editedAt,
		snapshot.historicalAuthorKind,
		snapshot.historicalAuthorName,
		snapshot.importedAt,
		snapshot.provenanceRedactedAt,
	]);
}
export type ApiCommentPageQuery = { limit: number; after: string | null };
export function encodeCommentCursor(taskId: string, after: string): string {
	return Buffer.from(JSON.stringify(["comments", 1, taskId, after])).toString(
		"base64url",
	);
}
export function parseCommentPageQuery(
	url: URL,
	taskId: string,
): ApiCommentPageQuery {
	const invalidQuery = () =>
		new PublicApiError(400, "invalid-query", "Invalid comment page query");
	for (const key of url.searchParams.keys())
		if (
			!["limit", "cursor"].includes(key) ||
			url.searchParams.getAll(key).length !== 1
		)
			throw invalidQuery();
	const limit = url.searchParams.get("limit");
	if (limit !== null && (!/^[1-9][0-9]*$/.test(limit) || Number(limit) > 100))
		throw invalidQuery();
	let after: string | null = null;
	const cursor = url.searchParams.get("cursor");
	if (cursor !== null) {
		try {
			if (!/^[a-zA-Z0-9_-]{1,2048}$/.test(cursor)) throw invalidQuery();
			const decoded: unknown = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					Buffer.from(cursor, "base64url"),
				),
			);
			if (
				!Array.isArray(decoded) ||
				decoded.length !== 4 ||
				decoded[0] !== "comments" ||
				decoded[1] !== 1 ||
				decoded[2] !== taskId ||
				!apiCommentIdSchema.safeParse(decoded[3]).success ||
				encodeCommentCursor(taskId, decoded[3]) !== cursor
			)
				throw invalidQuery();
			after = decoded[3];
		} catch {
			throw invalidQuery();
		}
	}
	return { limit: limit === null ? 50 : Number(limit), after };
}
