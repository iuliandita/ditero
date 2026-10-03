import { z } from "zod";
import { apiTaskCompleteSchema } from "../../domain/public-api-completion.ts";
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
	(paths["/api/v1/tasks/{id}"] as Record<string, unknown>).patch = {
		operationId: "update_task",
		tags: ["tasks"],
		security: [{ personalAccessToken: [] }],
		description:
			"Update title, notes, dueAt, dueAllDay or priority with a write token and current writable membership. Supply listId and stateToken from the observation as expectedState. Stale scalar state returns 409 before effects. Recurring tasks and habits accept title/notes/priority only; any due field is refused. The JSON body is bounded to 64 KiB. Same-key replay returns the current authorized task without applying the patch again; current write authority is required. Keys share the create/complete namespace.",
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
			"Delete an observed task using a write token and current writable origin-list membership. Supply parent state, child count/token, and explicit cascadeChildren. False requires no children. True deletes the exact observed children and dependent content through the native path. Stale parent or child state returns 409. JSON is limited to 4 KiB. Same-key replay acknowledges the original deletion without touching a recreated ID, and still requires current origin-list write authority. Keys share the account create/complete/update namespace.",
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
	return {
		openapi: "3.1.0",
		info: {
			title: "Ditero public API",
			version: "1",
			description:
				"Membership-scoped discovery and idempotent task creation for scripts and agents. Results use stable IDs; dashboard tasks are stored in authorized backing lists. Collection pages are ordered by ID and are live reads, not frozen snapshots.",
		},
		paths,
		components: {
			securitySchemes: {
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
