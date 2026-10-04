import { z } from "zod";
import {
	calendarFeedCreatedSchema,
	calendarFeedCreateSchema,
	calendarFeedMetadataSchema,
} from "../../domain/public-api-calendar-feed.ts";
import { apiTaskCompleteSchema } from "../../domain/public-api-completion.ts";
import {
	apiFolderCreateAckSchema,
	apiFolderCreateSchema,
	apiFolderDeleteAckSchema,
	apiFolderDeleteSchema,
	apiFolderObservationSchema,
	apiFolderUpdateAckSchema,
	apiFolderUpdateSchema,
} from "../../domain/public-api-folder.ts";
import {
	apiListCreateSchema,
	apiListCreationAckSchema,
} from "../../domain/public-api-list-create.ts";
import {
	apiListDeleteAckSchema,
	apiListDeleteSchema,
	apiListDeletionObservationSchema,
} from "../../domain/public-api-list-deletion.ts";
import {
	apiListObservationSchema,
	apiListUpdateAckSchema,
	apiListUpdateSchema,
} from "../../domain/public-api-list-update.ts";
import {
	PUBLIC_API_RESOURCES,
	publicApiResourceSchemas,
} from "../../domain/public-api-resources.ts";
import {
	apiTaskDeletedSchema,
	apiTaskDeleteSchema,
	apiTaskDeletionObservationSchema,
} from "../../domain/public-api-task-deletion.ts";
import {
	apiTaskPlacementAckSchema,
	apiTaskPlacementObservationSchema,
	apiTaskPlacementSchema,
} from "../../domain/public-api-task-placement.ts";
import {
	apiTaskRelationshipObservationSchema,
	apiTaskRelationshipsAckSchema,
	apiTaskRelationshipsSchema,
} from "../../domain/public-api-task-relationships.ts";
import {
	apiTaskObservationSchema,
	apiTaskUpdateSchema,
} from "../../domain/public-api-task-update.ts";
import { apiTaskCreateSchema } from "../../domain/public-api-writes.ts";

const problem = {
	description: "Request refused",
	content: {
		"application/problem+json": {
			schema: {
				type: "object",
				required: ["type", "title", "status", "code"],
				properties: {
					type: { type: "string" },
					title: { type: "string" },
					status: { type: "integer" },
					code: { type: "string" },
				},
			},
		},
	},
};
const errors = {
	"400": problem,
	"401": problem,
	"403": problem,
	"404": problem,
	"409": problem,
	"410": problem,
	"413": problem,
	"415": problem,
	"429": problem,
	"500": problem,
	"503": problem,
};
function response(data: unknown, paginated = false) {
	return {
		description: "Successful read",
		content: {
			"application/json": {
				schema: {
					type: "object",
					required: ["version", "data", "nextCursor"],
					additionalProperties: false,
					properties: {
						version: { type: "integer", const: 1 },
						data,
						nextCursor: paginated
							? { type: ["string", "null"] }
							: { type: "null" },
					},
				},
			},
		},
	};
}

export function publicApiOpenApi() {
	const paths: Record<string, unknown> = {};
	for (const resource of PUBLIC_API_RESOURCES) {
		const schema = z.toJSONSchema(publicApiResourceSchemas[resource]);
		const query = [
			{
				name: "limit",
				in: "query",
				schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
			},
			{
				name: "cursor",
				in: "query",
				schema: { type: "string", maxLength: 2048 },
				description:
					"Opaque cursor bound to this collection and filters. Keep other filters unchanged.",
			},
			{
				name: "workspaceId",
				in: "query",
				schema: { type: "string", minLength: 1, maxLength: 256 },
			},
			...(resource === "tasks"
				? [
						{
							name: "listId",
							in: "query",
							schema: { type: "string", minLength: 1, maxLength: 256 },
						},
						{ name: "done", in: "query", schema: { type: "boolean" } },
					]
				: []),
		];
		paths[`/api/v1/${resource}`] = {
			get: {
				operationId: `list_${resource}`,
				tags: [resource],
				security: [{ personalAccessToken: [] }],
				parameters: query,
				responses: {
					"200": response(
						{ type: "array", maxItems: 100, items: schema },
						true,
					),
					...errors,
				},
			},
		};
		paths[`/api/v1/${resource}/{id}`] = {
			get: {
				operationId: `get_${resource}`,
				tags: [resource],
				security: [{ personalAccessToken: [] }],
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string", minLength: 1, maxLength: 256 },
					},
				],
				responses: { "200": response(schema), ...errors },
			},
		};
	}
	(paths["/api/v1/lists"] as Record<string, unknown>).post = {
		operationId: "create_list",
		tags: ["lists"],
		security: [{ personalAccessToken: [] }],
		description:
			"Create a root list using a write token and current Member, Admin, or Owner membership. JSON is limited to 4 KiB; no query parameters, invitations or access grants. The server assigns ID, owner, append position and defaults. Preserve the same key and body after uncertain transport outcomes. Replay requires current original-workspace write authority and returns the immutable original creation snapshot, even after deletion or ID recreation; it does not assert current existence or incarnation. Use a separate authorized GET for current state.",
		parameters: [
			{
				name: "Idempotency-Key",
				in: "header",
				required: true,
				schema: { type: "string", format: "uuid" },
				description:
					"Account-scoped request identity shared with every task write. A different operation or canonical body returns 409.",
			},
		],
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: z.toJSONSchema(apiListCreateSchema, { io: "input" }),
				},
			},
		},
		responses: {
			"201": {
				...response(z.toJSONSchema(apiListCreationAckSchema)),
				description: "List created; original creation acknowledgement",
			},
			"200": {
				...response(z.toJSONSchema(apiListCreationAckSchema)),
				description:
					"Idempotent replay of the original creation acknowledgement",
			},
			...errors,
		},
	};

	paths["/api/v1/lists/{id}/observation"] = {
		get: {
			operationId: "observe_list",
			tags: ["lists"],
			security: [{ personalAccessToken: [] }],
			description:
				"Read a strict ApiList snapshot and SHA256 token of its versioned canonical scalar state. Covers id, workspaceId, ownerId, title, kind, icon, folderId, sortKey and completedDisplay. Read tokens and viewers may observe. This live read is not a lock, monotonic revision, relationship revision or durable incarnation identity; identical state, including identical recreation, may produce the same token.",
			parameters: [
				{
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
			],
			responses: {
				"200": response(z.toJSONSchema(apiListObservationSchema)),
				...errors,
			},
		},
	};
	(paths["/api/v1/lists/{id}"] as Record<string, unknown>).patch = {
		operationId: "update_list",
		tags: ["lists"],
		security: [{ personalAccessToken: [] }],
		description:
			"Update title, icon, completedDisplay, same-workspace folderId and fractional sortKey using a write token and current Member/Admin/Owner membership. JSON is limited to 4 KiB; no query parameters. Supply original workspaceId and observation stateToken as expectedState. folderId is null to detach or a visible folder in the original workspace; initially missing/foreign targets return 404, raced deletion may return 503. sortKey is a valid opaque base-62 fractional key of 2-256 ASCII characters. Sibling order is not observed. Stale scalar state returns 409. Changed metadata or placement on pending import containers returns 409; unchanged metadata may be acknowledged. Caller owns the exact UUID/body, with no automatic observe, retry or rebase. Keys share the account namespace with list creation and all task writes; different operation/body returns 409. Replay returns the immutable original list-update-ack snapshot without mutation, even after deletion/recreation, and requires live actor/write PAT/current original-workspace write membership. It makes no current-incarnation assertion.",
		parameters: [
			{
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string", minLength: 1, maxLength: 256 },
			},
			{
				name: "Idempotency-Key",
				in: "header",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
		],
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: z.toJSONSchema(apiListUpdateSchema, { io: "input" }),
				},
			},
		},
		responses: {
			"200": response(z.toJSONSchema(apiListUpdateAckSchema)),
			...errors,
		},
	};

	paths["/api/v1/lists/{id}/deletion-observation"] = {
		get: {
			operationId: "observe_list_deletion",
			tags: ["lists"],
			security: [{ personalAccessToken: [] }],
			description:
				"Read the strict ApiList scalar snapshot/stateToken plus a version-1 count/token covering every persisted task column, including children and timestamp microseconds, from one cursor snapshot ordered by ID. No row limit; 256-row pages and a five-second cumulative scan deadline return 503 on incomplete scans. Read tokens and Viewers may observe. Comments, assignments, labels, history and attachments follow native dependent deletion rules; they are not independently fingerprinted. This state token is not a monotonic revision or durable incarnation identity; identical recreation may match.",
			parameters: [
				{
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
			],
			responses: {
				"200": response(z.toJSONSchema(apiListDeletionObservationSchema)),
				...errors,
			},
		},
	};
	(paths["/api/v1/lists/{id}"] as Record<string, unknown>).delete = {
		operationId: "delete_list",
		tags: ["lists"],
		security: [{ personalAccessToken: [] }],
		description:
			"Delete an observed list with a write token and current creator Member, Admin or Owner authority. Supply original workspaceId, expectedState, expectedTasksState and explicit cascadeTasks. False requires zero tasks; true acknowledges all observed tasks and native dependent cascades. JSON is limited to 4 KiB; no query parameters. Changed scalar/task state returns 409 before effects. Native deletion and receipt commit atomically; pending import activation does not block deletion. Shared account UUID/body identity conflicts with every other list/task write. Same-key replay returns the immutable original list-delete-ack snapshot/deletedTasks count without touching a replacement or asserting current absence; replay requires current original-workspace creator/Admin/Owner authority against the captured original owner. No automatic observation, retry or replan.",
		parameters: [
			{
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string", minLength: 1, maxLength: 256 },
			},
			{
				name: "Idempotency-Key",
				in: "header",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
		],
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: z.toJSONSchema(apiListDeleteSchema, { io: "input" }),
				},
			},
		},
		responses: {
			"200": response(z.toJSONSchema(apiListDeleteAckSchema)),
			...errors,
		},
	};

	for (const [suffix, method, operation, input, output] of [
		[
			"placement-observation",
			"get",
			"observe_task_placement",
			null,
			apiTaskPlacementObservationSchema,
		],
		[
			"placement",
			"patch",
			"place_task",
			apiTaskPlacementSchema,
			apiTaskPlacementAckSchema,
		],
	] as const) {
		paths[`/api/v1/tasks/{id}/${suffix}`] = {
			[method]: {
				operationId: operation,
				tags: ["tasks"],
				security: [{ personalAccessToken: [] }],
				description:
					"Observed task ordering or same-workspace, same-kind root relocation. No parent changes or cross-workspace conversion. Write JSON is limited to4 KiB. Supply target list observation and explicit exact child cascade acknowledgment for relocation; ordering uses false/null. Shared account request UUID, original immutable placement acknowledgment on replay, current original-workspace write authority. No automatic retry, observation or replan.",
				parameters: [
					{
						name: "id",
						in: "path",
						required: true,
						schema: { type: "string" },
					},
					...(input
						? [
								{
									name: "Idempotency-Key",
									in: "header",
									required: true,
									schema: { type: "string", format: "uuid" },
								},
							]
						: []),
				],
				...(input
					? {
							requestBody: {
								required: true,
								content: {
									"application/json": {
										schema: z.toJSONSchema(input, { io: "input" }),
									},
								},
							},
						}
					: {}),
				responses: { "200": response(z.toJSONSchema(output)), ...errors },
			},
		};
	}

	(paths["/api/v1/tasks"] as Record<string, unknown>).post = {
		operationId: "create_task",
		tags: ["tasks"],
		security: [{ personalAccessToken: [] }],
		description:
			"Create a task using a write token and an existing Member, Admin, or Owner membership. Assignees must be active workspace members and labels must belong to the workspace. No invitations or access grants are created. Retry the same canonical request with the same key after uncertain transport outcomes.",
		parameters: [
			{
				name: "Idempotency-Key",
				in: "header",
				required: true,
				schema: { type: "string", format: "uuid" },
				description:
					"Account-scoped request identity. Reuse with another payload returns 409; a deleted task returns 410 while its original list remains accessible.",
			},
		],
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: z.toJSONSchema(apiTaskCreateSchema, { io: "input" }),
				},
			},
		},
		responses: {
			"201": {
				...response(z.toJSONSchema(publicApiResourceSchemas.tasks)),
				description: "Task created",
			},
			"200": {
				...response(z.toJSONSchema(publicApiResourceSchemas.tasks)),
				description: "Idempotent replay returning the current authorized task",
			},
			...errors,
		},
	};
	paths["/api/v1/tasks/{id}/complete"] = {
		post: {
			operationId: "complete_task",
			tags: ["tasks"],
			security: [{ personalAccessToken: [] }],
			description:
				"Complete the observed task occurrence using a write token and a writable workspace membership. The required list and due instant guard against moved tasks and changed recurring occurrences. Habits require a separate occurrence workflow. Reuse the same key and body after an uncertain outcome; replay returns the current authorized task without completing it again.",
			parameters: [
				{ name: "id", in: "path", required: true, schema: { type: "string" } },
				{
					name: "Idempotency-Key",
					in: "header",
					required: true,
					schema: { type: "string", format: "uuid" },
				},
			],
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: z.toJSONSchema(apiTaskCompleteSchema, { io: "input" }),
					},
				},
			},
			responses: {
				"200": response(z.toJSONSchema(publicApiResourceSchemas.tasks)),
				...errors,
			},
		},
	};
	paths["/api/v1/tasks/{id}/observation"] = {
		get: {
			operationId: "observe_task",
			tags: ["tasks"],
			security: [{ personalAccessToken: [] }],
			description:
				"Read a versioned scalar task snapshot and its SHA256 state token. This is a live read of the listed fields, not a relationship revision or a lock. Viewer memberships and read tokens are permitted.",
			parameters: [
				{
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
			],
			responses: {
				"200": response(z.toJSONSchema(apiTaskObservationSchema)),
				...errors,
			},
		},
	};
	paths["/api/v1/tasks/{id}/relationships"] = {
		get: {
			operationId: "observe_task_relationships",
			tags: ["tasks"],
			security: [{ personalAccessToken: [] }],
			description:
				"Read complete task scope, assignment IDs and label IDs with a SHA256 state token. Scalar fields and other dependent resources are not covered. Read tokens and Viewer members may observe. Evidence limits fail explicitly without truncation.",
			parameters: [
				{
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
			],
			responses: {
				"200": response(z.toJSONSchema(apiTaskRelationshipObservationSchema)),
				...errors,
			},
		},
		patch: {
			operationId: "update_task_relationships",
			tags: ["tasks"],
			security: [{ personalAccessToken: [] }],
			description:
				"Replace both complete desired sets: up to 20 unique active workspace assignees and 50 unique same-workspace labels. Empty arrays clear relationships. Requires the observed scope/token and a write token with current Member+ authority. Query-free JSON body is bounded to 64 KiB. Retry identical body/key after an uncertain result; replay acknowledges original desired sets without touching a recreated task. UUID keys share the account mutation namespace.",
			parameters: [
				{
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
				{
					name: "Idempotency-Key",
					in: "header",
					required: true,
					schema: { type: "string", format: "uuid" },
				},
			],
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: z.toJSONSchema(apiTaskRelationshipsSchema, { io: "input" }),
					},
				},
			},
			responses: {
				"200": response(z.toJSONSchema(apiTaskRelationshipsAckSchema)),
				...errors,
			},
		},
	};

	(paths["/api/v1/tasks/{id}"] as Record<string, unknown>).patch = {
		operationId: "update_task",
		tags: ["tasks"],
		security: [{ personalAccessToken: [] }],
		description:
			"Update title, notes, dueAt, dueAllDay or priority with a write token and current writable membership. Supply listId and stateToken from the observation as expectedState. Stale scalar state returns 409 before effects. Recurring tasks and habits accept title/notes/priority only; any due field is refused. The JSON body is bounded to 64 KiB. Same-key replay returns the current authorized task without applying the patch again; current write authority is required. Keys share the account namespace with list creation and all task writes.",
		parameters: [
			{
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string", minLength: 1, maxLength: 256 },
			},
			{
				name: "Idempotency-Key",
				in: "header",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
		],
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: z.toJSONSchema(apiTaskUpdateSchema, { io: "input" }),
				},
			},
		},
		responses: {
			"200": response(z.toJSONSchema(publicApiResourceSchemas.tasks)),
			...errors,
		},
	};
	paths["/api/v1/tasks/{id}/deletion-observation"] = {
		get: {
			operationId: "observe_task_deletion",
			tags: ["tasks"],
			security: [{ personalAccessToken: [] }],
			description:
				"Read the parent scalar snapshot and a count/token of every persisted child task field from one cursor snapshot. Read tokens and viewers may observe. Related comments, files and assignments are covered by the explicit deletion scope, not this token.",
			parameters: [
				{
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
			],
			responses: {
				"200": response(z.toJSONSchema(apiTaskDeletionObservationSchema)),
				...errors,
			},
		},
	};
	(paths["/api/v1/tasks/{id}"] as Record<string, unknown>).delete = {
		operationId: "delete_task",
		tags: ["tasks"],
		security: [{ personalAccessToken: [] }],
		description:
			"Delete an observed task using a write token and current writable origin-list membership. Supply parent state, child count/token, and explicit cascadeChildren. False requires no children. True deletes the exact observed children and dependent content through the native path. Stale parent or child state returns 409. JSON is limited to 4 KiB. Same-key replay acknowledges the original deletion without touching a recreated ID, and still requires current origin-list write authority. Keys share the account namespace with list creation and all task writes.",
		parameters: [
			{
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string", minLength: 1, maxLength: 256 },
			},
			{
				name: "Idempotency-Key",
				in: "header",
				required: true,
				schema: { type: "string", format: "uuid" },
			},
		],
		requestBody: {
			required: true,
			content: {
				"application/json": { schema: z.toJSONSchema(apiTaskDeleteSchema) },
			},
		},
		responses: {
			"200": response(z.toJSONSchema(apiTaskDeletedSchema)),
			...errors,
		},
	};
	paths["/api/v1/calendar.ics"] = {
		get: {
			operationId: "download_calendar_snapshot",
			tags: ["tasks"],
			security: [{ personalAccessToken: [] }],
			description:
				"Authenticated download of current persisted tasks as VTODO. Read tokens and viewers are permitted. This bounded snapshot contains no future recurrence instances, RRULE or alarms. All-day DUE dates use the caller timezone; timed DUE values are UTC. Maximum 10000 tasks, 8 MiB output and 128 KiB combined text per task; overflow returns a JSON problem, never a partial calendar. No query-token or public-feed access.",
			parameters: [
				{
					name: "workspaceId",
					in: "query",
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
				{
					name: "listId",
					in: "query",
					schema: { type: "string", minLength: 1, maxLength: 256 },
				},
			],
			responses: {
				"200": {
					description: "Calendar download snapshot",
					content: { "text/calendar": { schema: { type: "string" } } },
				},
				...errors,
				"422": problem,
			},
		},
	};

	const folderIdParameter = {
		name: "id",
		in: "path",
		required: true,
		schema: { type: "string", minLength: 1, maxLength: 256 },
	};
	const folderKeyParameter = {
		name: "Idempotency-Key",
		in: "header",
		required: true,
		schema: { type: "string", format: "uuid" },
	};
	paths["/api/v1/folders/{id}/observation"] = {
		get: {
			operationId: "observe_folder",
			tags: ["folders"],
			security: [{ personalAccessToken: [] }],
			parameters: [folderIdParameter],
			description:
				"Read strict ApiFolder scalar snapshot and version-1 SHA256 state token covering id, workspaceId, name and sortKey. Read tokens and Viewers may observe. Live state is not a lock, monotonic revision or durable incarnation identity; identical recreation may match.",
			responses: {
				"200": response(z.toJSONSchema(apiFolderObservationSchema)),
				...errors,
			},
		},
	};
	(paths["/api/v1/folders"] as Record<string, unknown>).post = {
		operationId: "create_folder",
		tags: ["folders"],
		security: [{ personalAccessToken: [] }],
		parameters: [folderKeyParameter],
		description:
			"Create a folder using a write token and current Member/Admin/Owner membership. Strict JSON is limited to 4 KiB; no query parameters. Name is trimmed and limited to 1-500 characters. Server assigns UUID and append position. Account UUID namespace is shared with all task/list/folder writes. Same-key replay returns immutable original folder-create-ack under current original-workspace authority without recreating or changing replacements.",
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: z.toJSONSchema(apiFolderCreateSchema, { io: "input" }),
				},
			},
		},
		responses: {
			"201": response(z.toJSONSchema(apiFolderCreateAckSchema)),
			"200": response(z.toJSONSchema(apiFolderCreateAckSchema)),
			...errors,
		},
	};
	for (const [method, operation, input, ack, description] of [
		[
			"patch",
			"update_folder",
			apiFolderUpdateSchema,
			apiFolderUpdateAckSchema,
			"Rename only name after native folder locks using workspaceId and expectedState from observation. Changed state returns 409. Changed names with pending import activation return 409; unchanged names may succeed.",
		],
		[
			"delete",
			"delete_folder",
			apiFolderDeleteSchema,
			apiFolderDeleteAckSchema,
			"Delete only an empty observed folder after native locks. Changed state returns 409; any list returns 409 folder-not-empty. No cascade, reparenting, list/task deletion or orphaning.",
		],
	] as const) {
		(paths["/api/v1/folders/{id}"] as Record<string, unknown>)[method] = {
			operationId: operation,
			tags: ["folders"],
			security: [{ personalAccessToken: [] }],
			parameters: [folderIdParameter, folderKeyParameter],
			description: `${description} Strict JSON is limited to 4 KiB; no query parameters. Requires valid write PAT, live actor and current original-workspace Member/Admin/Owner membership. Native mutation and immutable folder acknowledgement commit atomically. Matching account-scoped UUID/body replay requires current original-workspace authority, never affects replacement IDs and makes no current existence or absence claim. No automatic observation, retry or replanning.`,
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: z.toJSONSchema(input, { io: "input" }),
					},
				},
			},
			responses: { "200": response(z.toJSONSchema(ack)), ...errors },
		};
	}
	paths["/api/v1/me"] = {
		get: {
			operationId: "get_profile",
			security: [{ personalAccessToken: [] }],
			responses: {
				"200": response({
					type: "object",
					required: [
						"id",
						"name",
						"timezone",
						"timezoneChosen",
						"locale",
						"serverTime",
						"tokenAccess",
					],
					properties: {
						id: { type: "string" },
						name: { type: "string" },
						timezone: { type: "string" },
						timezoneChosen: { type: "boolean" },
						locale: { type: "string" },
						serverTime: { type: "string", format: "date-time" },
						tokenAccess: { type: "string", enum: ["read", "write"] },
					},
				}),
				...errors,
			},
		},
	};
	paths["/api/v1/calendar-feeds/{secret}/calendar.ics"] = {
		get: {
			operationId: "download_calendar_feed",
			security: [],
			parameters: [
				{
					name: "secret",
					in: "path",
					required: true,
					schema: {
						type: "string",
						pattern: "^ditero_feed_[A-Za-z0-9_-]{43}$",
					},
				},
			],
			description:
				"Read-only fixed-list capability. No query parameters. Every request requires the original live account, current membership, list scope and unexpired nonrevoked feed. Recurrence exports persisted tasks only.",
			responses: {
				"200": {
					description: "Current calendar snapshot",
					content: { "text/calendar": { schema: { type: "string" } } },
				},
				"422": problem,
				...errors,
			},
		},
	};
	paths["/api/calendar-feeds"] = {
		get: {
			operationId: "list_calendar_feeds",
			security: [{ accountSession: [] }],
			responses: {
				"200": response(z.toJSONSchema(z.array(calendarFeedMetadataSchema))),
				...errors,
			},
		},
		post: {
			operationId: "create_calendar_feed",
			security: [{ accountSession: [] }],
			description:
				"Cookie-authenticated, origin-guarded creation. Secret and relative path are returned once; metadata lists never return the capability.",
			requestBody: {
				required: true,
				content: {
					"application/json": {
						schema: z.toJSONSchema(calendarFeedCreateSchema),
					},
				},
			},
			responses: {
				"201": response(z.toJSONSchema(calendarFeedCreatedSchema)),
				...errors,
			},
		},
	};
	paths["/api/calendar-feeds/{id}"] = {
		delete: {
			operationId: "revoke_calendar_feed",
			security: [{ accountSession: [] }],
			parameters: [
				{
					name: "id",
					in: "path",
					required: true,
					schema: { type: "string", format: "uuid" },
				},
			],
			responses: { "200": response({ type: "object" }), ...errors },
		},
	};
	return {
		openapi: "3.1.0",
		info: {
			title: "Ditero public API",
			version: "1",
			description:
				"Membership-scoped discovery and idempotent list/task writes for scripts and agents. Results use stable IDs; dashboard tasks are stored in authorized backing lists. Collection pages are ordered by ID and are live reads, not frozen snapshots.",
		},
		paths,
		components: {
			securitySchemes: {
				accountSession: {
					type: "apiKey",
					in: "cookie",
					name: "better-auth.session_token",
					description:
						"Authenticated account session; mutations also require the existing origin guard.",
				},
				personalAccessToken: {
					type: "http",
					scheme: "bearer",
					bearerFormat: "Personal access token",
					description:
						"Create an expiring read or write token in account settings. Membership roles remain authoritative.",
				},
			},
		},
	};
}
