import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { compactCommentSnapshot } from "../server/public-api/comment-observation.ts";
import { publicApiOpenApi } from "../server/public-api/openapi.ts";
import {
	apiCommentAckSchema,
	apiCommentIdSchema,
	apiCommentSnapshotSchema,
	canonicalApiCommentRequest,
	encodeCommentCursor,
	parseApiCommentCreate,
	parseApiCommentDelete,
	parseApiCommentUpdate,
	parseCommentPageQuery,
} from "./public-api-comments.ts";

const scope = { workspaceId: "ws", listId: "list" };
const token = "a".repeat(64);
const create = { ...scope, expectedTaskState: token, body: "  @Alice\n " };
const snapshot = {
	version: 1 as const,
	commentId: "comment",
	taskId: "task",
	...scope,
	authorId: "actor",
	body: "é😀",
	createdAt: "2026-10-04T00:00:00.123456Z",
	editedAt: null,
	historicalAuthorKind: null,
	historicalAuthorName: null,
	importedAt: null,
	provenanceRedactedAt: null,
};
describe("public comment contracts", () => {
	test("native create limits preserve empty body and whitespace; edit remains uncapped", () => {
		expect(parseApiCommentCreate(create).body).toBe(create.body);
		expect(parseApiCommentCreate({ ...create, body: "" }).body).toBe("");
		expect(() =>
			parseApiCommentCreate({ ...create, body: "x".repeat(10000) }),
		).not.toThrow();
		expect(() =>
			parseApiCommentCreate({ ...create, body: "x".repeat(10001) }),
		).toThrow();
		expect(
			parseApiCommentUpdate({
				...scope,
				expectedState: token,
				body: "x".repeat(20000),
			}).body.length,
		).toBe(20000);
	});
	test("reject hostile descriptors without invoking accessors and reject implicit fields", () => {
		let touched = false;
		const getter = { ...create };
		Object.defineProperty(getter, "body", {
			enumerable: true,
			get: () => {
				touched = true;
				return "x";
			},
		});
		for (const value of [
			getter,
			Object.assign(Object.create({}), create),
			{ ...create, body: undefined },
			{ ...create, [Symbol("x")]: true },
			{ ...create, authorId: "other" },
			{ ...create, body: "\ud800" },
			{ ...create, body: "a\0b" },
		])
			expect(() => parseApiCommentCreate(value)).toThrow();
		expect(touched).toBe(false);
	});
	test("IDs refuse malformed Unicode, controls and path dot segments", () => {
		for (const id of [
			"",
			"x".repeat(257),
			"a\0b",
			"a\nb",
			"\ud800",
			".",
			"..",
			"a/../b",
		])
			expect(apiCommentIdSchema.safeParse(id).success).toBe(false);
		expect(apiCommentIdSchema.safeParse("😀").success).toBe(true);
	});
	test("deletion scope is explicit and metadata immutable", () => {
		expect(
			parseApiCommentDelete({
				...scope,
				expectedState: token,
				deleteScope: "comment-and-attachments",
			}).deleteScope,
		).toBe("comment-and-attachments");
		for (const value of [
			{ ...scope, expectedState: token },
			{ ...scope, expectedState: token, deleteScope: "comment" },
			{
				...scope,
				expectedState: token,
				deleteScope: "comment-and-attachments",
				cascade: true,
			},
		])
			expect(() => parseApiCommentDelete(value)).toThrow();
	});
	test("canonical fingerprints bind operation, route, exact whitespace and observations", () => {
		const first = canonicalApiCommentRequest("create", "task", null, create);
		expect(
			canonicalApiCommentRequest("create", "task", null, {
				body: create.body,
				listId: "list",
				workspaceId: "ws",
				expectedTaskState: token,
			}),
		).toBe(first);
		for (const other of [
			canonicalApiCommentRequest("create", "other", null, create),
			canonicalApiCommentRequest("create", "task", null, {
				...create,
				body: create.body.trim(),
			}),
			canonicalApiCommentRequest("create", "task", null, {
				...create,
				expectedTaskState: "b".repeat(64),
			}),
			canonicalApiCommentRequest("update", "task", "comment", {
				...scope,
				expectedState: token,
				body: create.body,
			}),
		])
			expect(other).not.toBe(first);
	});
	test("compact evidence hashes complete UTF8 and preserves timestamp microseconds", () => {
		expect(apiCommentSnapshotSchema.parse(snapshot).createdAt).toBe(
			snapshot.createdAt,
		);
		const compact = compactCommentSnapshot(snapshot);
		expect(compact.body).toEqual({
			sha256: createHash("sha256").update("é😀").digest("hex"),
			utf8Bytes: 6,
		});
		expect(compact.createdAt).toBe("2026-10-04T00:00:00.123456Z");
		expect(
			JSON.stringify(
				compactCommentSnapshot({ ...snapshot, body: "x".repeat(300000) }),
			).length,
		).toBeLessThan(2000);
	});
	test("acknowledgments refuse mismatched original scope and private provenance fields", () => {
		const ack = {
			kind: "comment-create-ack",
			originalWorkspaceId: "ws",
			originalListId: "list",
			originalTaskId: "task",
			snapshot,
		};
		expect(apiCommentAckSchema.safeParse(ack).success).toBe(true);
		expect(
			apiCommentAckSchema.safeParse({ ...ack, originalWorkspaceId: "foreign" })
				.success,
		).toBe(false);
		expect(
			apiCommentAckSchema.safeParse({
				...ack,
				snapshot: { ...snapshot, sourceNamespace: "private" },
			}).success,
		).toBe(false);
	});
	test("cursor binds exact task and refuses malformed, duplicate or unknown query parameters", () => {
		const cursor = encodeCommentCursor("task", "comment");
		expect(
			parseCommentPageQuery(
				new URL(`http://localhost/?limit=1&cursor=${cursor}`),
				"task",
			),
		).toEqual({ limit: 1, after: "comment" });
		for (const query of [
			"limit=0",
			"limit=101",
			"limit=01",
			"limit=1&limit=2",
			"x=1",
			"cursor=",
			"cursor=%%%",
			`cursor=${cursor}`,
		])
			expect(() =>
				parseCommentPageQuery(new URL(`http://localhost/?${query}`), "other"),
			).toThrow();
	});
	test("OpenAPI declares all five operations with strict comment bodies", () => {
		const paths = publicApiOpenApi().paths;
		expect(paths["/api/v1/tasks/{id}/comments"]).toHaveProperty("get");
		expect(paths["/api/v1/tasks/{id}/comments"]).toHaveProperty("post");
		expect(paths["/api/v1/tasks/{id}/comments/{commentId}"]).toHaveProperty(
			"patch",
		);
		expect(paths["/api/v1/tasks/{id}/comments/{commentId}"]).toHaveProperty(
			"delete",
		);
		expect(
			paths["/api/v1/tasks/{id}/comments/{commentId}/observation"],
		).toHaveProperty("get");
	});
});
