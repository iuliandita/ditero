import { z } from "zod";
import {
	PUBLIC_API_RESOURCES,
	publicApiResourceSchemas,
} from "../../domain/public-api-resources.ts";
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
