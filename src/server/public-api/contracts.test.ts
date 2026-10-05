import { describe, expect, test } from "vitest";
import {
	PublicApiError,
	publicApiProblem,
	tokenCreateSchema,
} from "../../domain/public-api.ts";
import { bearerToken, encodePageCursor, parsePageQuery } from "./contracts.ts";
import { publicApiOpenApi } from "./openapi.ts";

const url = (query = "") => new URL(`http://localhost/api/v1/tasks${query}`);

test("OpenAPI derives all implemented collection DTOs from shared schemas", () => {
	const document = publicApiOpenApi();
	expect(document.openapi).toBe("3.1.0");
	expect(Object.keys(document.paths)).toHaveLength(36);
	expect(document.paths).toHaveProperty("/api/v1/dashboards/{id}");
	expect(document.paths).toHaveProperty("/api/v1/tasks");
	expect(JSON.stringify(document)).not.toContain("token_hash");
});

test("OpenAPI exposes strict scalar update and a separate observation without changing the task DTO", () => {
	const document = publicApiOpenApi();
	const encoded = JSON.stringify(document.paths["/api/v1/tasks/{id}"]);
	expect(encoded).toContain('"operationId":"update_task"');
	expect(encoded).toContain('"expectedState"');
	expect(encoded).toContain('"additionalProperties":false');
	expect(document.paths).toHaveProperty("/api/v1/tasks/{id}/observation");
	const taskGet = (document.paths["/api/v1/tasks/{id}"] as { get: unknown })
		.get;
	expect(JSON.stringify(taskGet)).not.toContain("stateToken");
});

describe("public API cursor contract", () => {
	test("binds cursors to the collection and filters, while allowing page-size changes", () => {
		const query = parsePageQuery(url("?listId=list-1&done=false"), "tasks");
		const cursor = encodePageCursor("tasks", query, "task-2");
		expect(
			parsePageQuery(
				url(`?listId=list-1&done=false&limit=1&cursor=${cursor}`),
				"tasks",
			).after,
		).toBe("task-2");
		expect(() =>
			parsePageQuery(
				url(`?listId=list-2&done=false&cursor=${cursor}`),
				"tasks",
			),
		).toThrow(PublicApiError);
		expect(() => parsePageQuery(url(`?cursor=${cursor}`), "lists")).toThrow(
			PublicApiError,
		);
	});
	test.each([
		"?limit=0",
		"?limit=101",
		"?limit=-1",
		"?limit=01",
		"?limit=1&limit=2",
		"?done=yes",
		"?listId=",
		"?offset=0",
		"?cursor=garbage",
		"?cursor=e30",
		"?workspaceId=a&workspaceId=b",
	])("rejects malformed or ambiguous input %s", (query) => {
		expect(() => parsePageQuery(url(query), "tasks")).toThrow(PublicApiError);
	});
});

test("bearer authentication never falls back to cookies or partial tokens", () => {
	const token = `ditero_pat_${"a".repeat(43)}`;
	expect(bearerToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(
		token,
	);
	for (const value of [
		token,
		`Bearer ${token} extra`,
		`Basic ${token}`,
		`Bearer ${token.slice(0, -1)}`,
	]) {
		expect(bearerToken(new Headers({ authorization: value }))).toBeNull();
	}
	expect(bearerToken(new Headers({ cookie: "session=anything" }))).toBeNull();
});

test("token defaults are read-only and expiring; privilege and lifetime inputs are exact", () => {
	expect(tokenCreateSchema.parse({ name: " Agent " })).toEqual({
		name: "Agent",
		access: "read",
		expiresInDays: 90,
	});
	for (const body of [
		{ name: "" },
		{ name: "bad\nname" },
		{ name: "agent", access: "admin" },
		{ name: "agent", expiresInDays: 366 },
		{ name: "agent", expiresInDays: 0 },
		{ name: "agent", userId: "other" },
	]) {
		expect(tokenCreateSchema.safeParse(body).success).toBe(false);
	}
});

test("unauthorized errors challenge bearer auth without disclosing token state", async () => {
	const response = publicApiProblem(
		new PublicApiError(
			401,
			"unauthorized",
			"A valid personal access token is required",
		),
	);
	expect(response.status).toBe(401);
	expect(response.headers.get("www-authenticate")).toBe(
		'Bearer realm="ditero"',
	);
	expect(response.headers.get("cache-control")).toBe("no-store");
	expect(response.headers.get("content-type")).toBe("application/problem+json");
	expect(await response.json()).toMatchObject({
		status: 401,
		code: "unauthorized",
	});
});

test("OpenAPI exposes explicit observed deletion without changing the task DTO", () => {
	const document = publicApiOpenApi();
	const operation = (
		document.paths["/api/v1/tasks/{id}"] as { delete: unknown }
	).delete;
	const encoded = JSON.stringify(operation);
	expect(encoded).toContain('"operationId":"delete_task"');
	expect(encoded).toContain('"expectedChildrenState"');
	expect(encoded).toContain('"cascadeChildren"');
	expect(encoded).toContain('"additionalProperties":false');
	expect(document.paths).toHaveProperty(
		"/api/v1/tasks/{id}/deletion-observation",
	);
});

test("OpenAPI declares a Bearer-only calendar download with JSON errors and strict scope filters", () => {
	const document = publicApiOpenApi();
	const operation = (
		document.paths["/api/v1/calendar.ics"] as {
			get: {
				parameters: { name: string }[];
				responses: Record<string, { content: Record<string, unknown> }>;
				security: unknown;
			};
		}
	).get;
	expect(operation.parameters.map((value) => value.name)).toEqual([
		"workspaceId",
		"listId",
	]);
	expect(operation.responses["200"].content).toHaveProperty("text/calendar");
	expect(operation.responses["422"].content).toHaveProperty(
		"application/problem+json",
	);
	expect(operation.security).toEqual([{ personalAccessToken: [] }]);
});

test("OpenAPI distinguishes immutable list creation acknowledgements from current list reads", () => {
	const paths = publicApiOpenApi().paths;
	const list = paths["/api/v1/lists"] as {
		get: unknown;
		post: {
			requestBody: {
				content: {
					"application/json": {
						schema: { required: string[]; additionalProperties: boolean };
					};
				};
			};
			responses: Record<string, unknown>;
		};
	};
	const input = list.post.requestBody.content["application/json"].schema;
	expect(input.required).toEqual(["workspaceId", "title", "kind"]);
	expect(input.additionalProperties).toBe(false);
	for (const status of ["200", "201"]) {
		expect(JSON.stringify(list.post.responses[status])).toContain(
			'"const":"list-create-ack"',
		);
		expect(JSON.stringify(list.post.responses[status])).toContain('"snapshot"');
	}
	expect(JSON.stringify(list.get)).not.toContain("list-create-ack");
	expect(Object.keys(paths)).toHaveLength(36);
});

test("OpenAPI exposes observed list metadata updates and immutable acknowledgements", () => {
	const paths = publicApiOpenApi().paths;
	const list = paths["/api/v1/lists/{id}"] as { get: unknown; patch: unknown };
	const encoded = JSON.stringify(list.patch);
	expect(encoded).toContain('"operationId":"update_list"');
	expect(encoded).toContain('"expectedState"');
	expect(encoded).toContain('"const":"list-update-ack"');
	expect(encoded).toContain('"additionalProperties":false');
	expect(JSON.stringify(list.get)).not.toContain("stateToken");
	expect(paths).toHaveProperty("/api/v1/lists/{id}/observation");
});

test("OpenAPI describes strict observed list deletion and immutable acknowledgements", () => {
	const paths = publicApiOpenApi().paths;
	const encoded = JSON.stringify(
		(paths["/api/v1/lists/{id}"] as { delete: unknown }).delete,
	);
	for (const field of [
		'"operationId":"delete_list"',
		'"expectedTasksState"',
		'"cascadeTasks"',
		'"const":"list-delete-ack"',
		'"additionalProperties":false',
	])
		expect(encoded).toContain(field);
	expect(paths).toHaveProperty("/api/v1/lists/{id}/deletion-observation");
});

test("OpenAPI distinguishes observed full relationship replacement from scalar edits", () => {
	const path = publicApiOpenApi().paths["/api/v1/tasks/{id}/relationships"];
	const encoded = JSON.stringify(path);
	expect(encoded).toContain('"operationId":"observe_task_relationships"');
	expect(encoded).toContain('"operationId":"update_task_relationships"');
	expect(encoded).toContain('"maxItems":20');
	expect(encoded).toContain('"maxItems":50');
	expect(encoded).toContain('"const":"task-relationships-update-ack"');
	expect(encoded).toContain('"additionalProperties":false');
});

test("OpenAPI exposes folder discovery, observation and strict immutable write acknowledgements", () => {
	const paths = publicApiOpenApi().paths;
	expect(paths).toHaveProperty("/api/v1/folders/{id}/observation");
	const create = JSON.stringify(
		(paths["/api/v1/folders"] as { post: unknown }).post,
	);
	expect(create).toContain('"const":"folder-create-ack"');
	expect(create).toContain('"additionalProperties":false');
	const detail = paths["/api/v1/folders/{id}"] as {
		get: unknown;
		patch: unknown;
		delete: unknown;
	};
	expect(JSON.stringify(detail.patch)).toContain('"const":"folder-update-ack"');
	expect(JSON.stringify(detail.delete)).toContain(
		'"const":"folder-delete-ack"',
	);
	expect(JSON.stringify(detail.get)).not.toContain("stateToken");
});

test("calendar feeds distinguish guarded account management from fixed public capabilities", () => {
	const document = publicApiOpenApi();
	expect(document.paths).toHaveProperty("/api/calendar-feeds");
	const feed = JSON.stringify(
		document.paths["/api/v1/calendar-feeds/{secret}/calendar.ics"],
	);
	expect(feed).toContain('"security":[]');
	expect(feed).not.toContain('"in":"query"');
	expect(feed).not.toContain("personalAccessToken");
});

test("list update schema describes bounded placement without new routes", () => {
	const document = publicApiOpenApi();
	const encoded = JSON.stringify(
		(document.paths["/api/v1/lists/{id}"] as { patch: unknown }).patch,
	);
	for (const field of [
		'"folderId"',
		'"sortKey"',
		'"maxLength":256',
		"2-256 ASCII",
		"initially missing/foreign targets return 404",
	])
		expect(encoded).toContain(field);
	expect(Object.keys(document.paths)).toHaveLength(36);
});

test("webhook delivery uses its own bearer scheme and a strict bounded body", () => {
	const document = publicApiOpenApi();
	const delivery = JSON.stringify(
		document.paths["/api/v1/webhooks/{id}/deliveries"],
	);
	expect(delivery).toContain("webhookCredential");
	expect(delivery).not.toContain("personalAccessToken");
	expect(delivery).not.toContain('"assigneeIds"');
	expect(delivery).toContain('"additionalProperties":false');
	expect(JSON.stringify(document.paths["/api/v1/webhooks"])).toContain(
		"personalAccessToken",
	);
});

test("placement has separate strict observations and immutable acknowledgment", () => {
	const paths = publicApiOpenApi().paths;
	expect(paths).toHaveProperty("/api/v1/tasks/{id}/placement-observation");
	const encoded = JSON.stringify(paths["/api/v1/tasks/{id}/placement"]);
	for (const field of [
		"expectedTargetState",
		"expectedChildrenState",
		"cascadeChildren",
		"task-place-ack",
		"sortKey",
		"parentId",
	])
		expect(encoded).toContain(field);
	expect(JSON.stringify(paths["/api/v1/tasks/{id}"])).not.toContain(
		"task-place-ack",
	);
});

test("comments declare five strict operations, compact observations and exact transport/replay limits", () => {
	const paths = publicApiOpenApi().paths;
	type Schema = {
		type?: string;
		required?: string[];
		additionalProperties?: boolean;
		properties?: Record<string, Schema>;
		maxLength?: number;
		items?: Schema;
	};
	type Operation = {
		operationId: string;
		description: string;
		security: unknown;
		parameters: { name: string; in: string; required?: boolean }[];
		requestBody?: {
			required: boolean;
			content: { "application/json": { schema: Schema } };
		};
		responses: Record<
			string,
			{ content: { "application/json": { schema: Schema } } }
		>;
	};
	const collection = paths["/api/v1/tasks/{id}/comments"] as {
		get: Operation;
		post: Operation;
	};
	const item = paths["/api/v1/tasks/{id}/comments/{commentId}"] as {
		patch: Operation;
		delete: Operation;
	};
	const observe = (
		paths["/api/v1/tasks/{id}/comments/{commentId}/observation"] as {
			get: Operation;
		}
	).get;
	expect([
		collection.get.operationId,
		collection.post.operationId,
		item.patch.operationId,
		item.delete.operationId,
		observe.operationId,
	]).toEqual([
		"list_task_comments",
		"create_task_comment",
		"patch_task_comment",
		"delete_task_comment",
		"observe_task_comment",
	]);
	for (const operation of [
		collection.get,
		collection.post,
		item.patch,
		item.delete,
		observe,
	])
		expect(operation.security).toEqual([{ personalAccessToken: [] }]);
	expect(collection.get.parameters.map((p) => p.name)).toEqual([
		"id",
		"limit",
		"cursor",
	]);
	expect(observe.parameters.map((p) => p.name)).toEqual(["id", "commentId"]);
	const dto =
		collection.get.responses["200"].content["application/json"].schema
			.properties?.data.items;
	expect(dto?.additionalProperties).toBe(false);
	expect(dto?.properties?.body).toMatchObject({ type: "string" });
	const snapshot =
		observe.responses["200"].content["application/json"].schema.properties?.data
			.properties?.snapshot;
	expect(snapshot?.properties?.body).toMatchObject({
		type: "object",
		additionalProperties: false,
		required: ["sha256", "utf8Bytes"],
		properties: { sha256: { type: "string" }, utf8Bytes: { type: "integer" } },
	});
	for (const [operation, required] of [
		[collection.post, ["workspaceId", "listId", "expectedTaskState", "body"]],
		[item.patch, ["workspaceId", "listId", "expectedState", "body"]],
		[item.delete, ["workspaceId", "listId", "expectedState", "deleteScope"]],
	] as const) {
		const input = operation.requestBody?.content["application/json"].schema;
		expect(input?.additionalProperties).toBe(false);
		expect(input?.required).toEqual(required);
		expect(operation.parameters).toContainEqual({
			name: "Idempotency-Key",
			in: "header",
			required: true,
			schema: { type: "string", format: "uuid" },
		});
		const encoded = JSON.stringify(operation.responses["200"]);
		for (const acknowledgment of [
			"comment-create-ack",
			"comment-update-ack",
			"comment-delete-ack",
		])
			expect(encoded).toContain(acknowledgment);
	}
	expect(
		collection.post.requestBody?.content["application/json"].schema.properties
			?.body.maxLength,
	).toBe(10000);
	expect(
		item.patch.requestBody?.content["application/json"].schema.properties?.body
			.maxLength,
	).toBeUndefined();
	expect(
		item.delete.requestBody?.content["application/json"].schema.properties
			?.deleteScope,
	).toMatchObject({ const: "comment-and-attachments" });
	expect(collection.get.description).toContain("256 KiB");
	expect(collection.get.description).toContain("without truncation");
	expect(collection.post.description).toContain("64 KiB");
	expect(collection.post.description).toContain("after commit");
	expect(collection.post.description).toContain("no automatic retry");
	expect(item.patch.description).toContain("64 KiB");
	expect(item.patch.description).toContain(
		"Imported comments cannot be edited",
	);
	expect(item.delete.description).toContain("4 KiB");
	expect(item.delete.description).toContain("no blob I/O");
	expect(observe.description).toContain("timestamp microseconds");
	const encoded = JSON.stringify([collection, item, observe]);
	for (const hidden of [
		"sourceNamespace",
		"sourceRowId",
		"historicalAuthorNamespace",
		"historicalAuthorPrincipalId",
	])
		expect(encoded).not.toContain(hidden);
});
