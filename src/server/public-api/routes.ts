import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import { UserContextError } from "../../db/user-context.ts";
import {
	apiResult,
	PUBLIC_API_ID,
	PublicApiError,
	publicApiProblem,
} from "../../domain/public-api.ts";
import { parseCalendarQuery } from "../../domain/public-api-calendar.ts";
import {
	apiCommentIdSchema,
	parseApiCommentCreate,
	parseApiCommentDelete,
	parseApiCommentUpdate,
	parseCommentPageQuery,
} from "../../domain/public-api-comments.ts";
import { parseApiTaskComplete } from "../../domain/public-api-completion.ts";
import {
	parseApiFolderCreate,
	parseApiFolderDelete,
	parseApiFolderUpdate,
} from "../../domain/public-api-folder.ts";
import { parseApiListCreate } from "../../domain/public-api-list-create.ts";
import { parseApiListDelete } from "../../domain/public-api-list-deletion.ts";
import { parseApiListUpdate } from "../../domain/public-api-list-update.ts";
import { parseApiTaskDelete } from "../../domain/public-api-task-deletion.ts";
import { parseApiTaskPlacement } from "../../domain/public-api-task-placement.ts";
import { parseApiTaskRelationships } from "../../domain/public-api-task-relationships.ts";
import { parseApiTaskUpdate } from "../../domain/public-api-task-update.ts";
import {
	parseApiIdempotencyKey,
	parseApiTaskCreate,
} from "../../domain/public-api-writes.ts";
import type { Guards } from "../guards.ts";
import { downloadApiCalendar } from "./calendar.ts";
import {
	createCalendarFeed,
	downloadCalendarFeed,
	listCalendarFeeds,
	revokeCalendarFeed,
} from "./calendar-feeds.ts";
import { readApiCommentObservation } from "./comment-observation.ts";
import { readApiComments } from "./comment-read.ts";
import { writeApiComment } from "./comment-write.ts";
import { completeApiTask } from "./complete.ts";
import {
	bearerToken,
	PUBLIC_API_RESOURCES,
	parsePageQuery,
} from "./contracts.ts";
import { deleteApiTask } from "./delete.ts";
import { readApiTaskDeletionObservation } from "./deletion-observation.ts";
import { deleteApiFolder } from "./folder-delete.ts";
import { readApiFolderObservation } from "./folder-observation.ts";
import { updateApiFolder } from "./folder-update.ts";
import { writeApiFolder } from "./folder-write.ts";
import { deleteApiList } from "./list-delete.ts";
import { readApiListDeletionObservation } from "./list-deletion-observation.ts";
import { readApiListObservation } from "./list-observation.ts";
import { updateApiList } from "./list-update.ts";
import { writeApiList } from "./list-write.ts";
import { publicApiOpenApi } from "./openapi.ts";
import { readApiProfile, readApiResource } from "./read.ts";
import { readApiTaskObservation } from "./task-observation.ts";
import { placeApiTask } from "./task-placement.ts";
import { readApiTaskPlacementObservation } from "./task-placement-observation.ts";
import { readApiTaskRelationshipObservation } from "./task-relationship-observation.ts";
import { writeApiTaskRelationships } from "./task-relationship-write.ts";
import {
	createPersonalAccessToken,
	listPersonalAccessTokens,
	revokePersonalAccessToken,
	withPersonalAccessToken,
} from "./tokens.ts";
import { updateApiTask } from "./update.ts";
import { type FlushApiEvents, writeApiTask } from "./write.ts";

type RateLimit = (request: Request, peerAddress?: string) => Promise<boolean>;

async function apiRequest(run: () => Promise<unknown>): Promise<unknown> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof PublicApiError) return publicApiProblem(error);
		if (error instanceof UserContextError)
			return publicApiProblem(
				new PublicApiError(401, "unauthorized", "Authentication is required"),
			);
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			(error.code === "55P03" ||
				error.code === "57014" ||
				error.code === "40P01")
		) {
			return publicApiProblem(
				new PublicApiError(503, "temporarily-unavailable", "Try again shortly"),
			);
		}
		console.error("public API request failed");
		return publicApiProblem(
			new PublicApiError(
				500,
				"internal-error",
				"The request could not be completed",
			),
		);
	}
}

async function boundedJson(
	request: Request,
	maximumBytes = 4096,
): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader)
		throw new PublicApiError(
			400,
			"invalid-json",
			"A JSON request body is required",
		);
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maximumBytes) {
				await reader.cancel();
				throw new PublicApiError(
					413,
					"request-too-large",
					"The request body is too large",
				);
			}
			chunks.push(value);
		}
		try {
			return JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
			);
		} catch {
			throw new PublicApiError(
				400,
				"invalid-json",
				"A valid JSON request body is required",
			);
		}
	} finally {
		reader.releaseLock();
	}
}

export function personalAccessTokenRoutes(
	pool: Pool,
	guards: Guards,
	rateLimit: RateLimit,
) {
	return new Elysia()
		.get(
			"/api/personal-access-tokens",
			guards.guardedGet(async (_request, session) =>
				apiRequest(async () =>
					apiResult(await listPersonalAccessTokens(pool, session.user.id)),
				),
			),
		)
		.post("/api/personal-access-tokens", ({ request, server }) =>
			guards.guardedPost(async (_request, session) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					return apiResult(
						await createPersonalAccessToken(
							pool,
							session.user.id,
							await boundedJson(request),
						),
						null,
						201,
					);
				}),
			)({ request }),
		)
		.delete("/api/personal-access-tokens/:id", ({ request, params }) =>
			guards.guardedPost(async (_request, session) =>
				apiRequest(async () => {
					if (!z.uuid().safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid token ID");
					return apiResult(
						await revokePersonalAccessToken(pool, session.user.id, params.id),
					);
				}),
			)({ request }),
		);
}

export function calendarFeedRoutes(
	pool: Pool,
	guards: Guards,
	rateLimit: RateLimit,
) {
	return new Elysia()
		.get(
			"/api/calendar-feeds",
			guards.guardedGet(async (request, session) =>
				apiRequest(async () => {
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					return apiResult(await listCalendarFeeds(pool, session.user.id));
				}),
			),
		)
		.post(
			"/api/calendar-feeds",
			({ request, server }) =>
				guards.guardedPost(async (_request, session) =>
					apiRequest(async () => {
						if (
							!(await rateLimit(request, server?.requestIP(request)?.address))
						)
							throw new PublicApiError(
								429,
								"rate-limited",
								"Too many requests",
							);
						if (new URL(request.url).search)
							throw new PublicApiError(
								400,
								"invalid-query",
								"This endpoint has no query parameters",
							);
						if (
							request.headers
								.get("content-type")
								?.split(";")[0]
								?.trim()
								.toLowerCase() !== "application/json"
						)
							throw new PublicApiError(
								415,
								"unsupported-media-type",
								"A JSON request body is required",
							);
						return apiResult(
							await createCalendarFeed(
								pool,
								session.user.id,
								await boundedJson(request),
							),
							null,
							201,
						);
					}),
				)({ request }),
			{ parse: "none" },
		)
		.delete("/api/calendar-feeds/:id", ({ request, params }) =>
			guards.guardedPost(async (_request, session) =>
				apiRequest(async () => {
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (!z.uuid().safeParse(params.id).success)
						throw new PublicApiError(
							400,
							"invalid-id",
							"Invalid calendar feed ID",
						);
					return apiResult(
						await revokeCalendarFeed(pool, session.user.id, params.id),
					);
				}),
			)({ request }),
		);
}

export function publicApiRoutes(
	pool: Pool,
	rateLimit: RateLimit,
	flushEvents?: FlushApiEvents,
) {
	const app = new Elysia()
		.get(
			"/api/v1/calendar-feeds/:secret/calendar.ics",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"Calendar feed scope is fixed",
						);
					return downloadCalendarFeed(pool, params.secret);
				}),
		)
		.get("/api/v1/calendar.ics", ({ request, server }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				return downloadApiCalendar(
					pool,
					bearerToken(request.headers),
					parseCalendarQuery(new URL(request.url)),
				);
			}),
		)
		.get("/api/v1/tasks/:id/relationships", ({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (!PUBLIC_API_ID.safeParse(params.id).success)
					throw new PublicApiError(400, "invalid-id", "Invalid task ID");
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					(client, actor) =>
						readApiTaskRelationshipObservation(client, actor, params.id),
				);
			}),
		)
		.patch(
			"/api/v1/tasks/:id/relationships",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid task ID");
					const input = parseApiTaskRelationships(
						await boundedJson(request, 65_536),
					);
					return writeApiTaskRelationships(
						pool,
						bearerToken(request.headers),
						params.id,
						input,
						requestId,
						flushEvents,
					);
				}),
			{ parse: "none" },
		)
		.get(
			"/api/v1/tasks/:id/placement-observation",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid task ID");
					return withPersonalAccessToken(
						pool,
						bearerToken(request.headers),
						"read",
						(client, actor) =>
							readApiTaskPlacementObservation(client, actor, params.id),
					);
				}),
		)
		.patch(
			"/api/v1/tasks/:id/placement",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid task ID");
					const input = parseApiTaskPlacement(await boundedJson(request, 4096));
					return placeApiTask(
						pool,
						bearerToken(request.headers),
						params.id,
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.get("/api/v1/tasks/:id/observation", ({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (!PUBLIC_API_ID.safeParse(params.id).success)
					throw new PublicApiError(400, "invalid-id", "Invalid task ID");
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					(client, actor) => readApiTaskObservation(client, actor, params.id),
				);
			}),
		)
		.get(
			"/api/v1/tasks/:id/deletion-observation",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid task ID");
					return withPersonalAccessToken(
						pool,
						bearerToken(request.headers),
						"read",
						(client, actor) =>
							readApiTaskDeletionObservation(client, actor, params.id),
					);
				}),
		)
		.delete(
			"/api/v1/tasks/:id",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid task ID");
					return deleteApiTask(
						pool,
						bearerToken(request.headers),
						params.id,
						parseApiTaskDelete(await boundedJson(request)),
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.patch(
			"/api/v1/tasks/:id",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid task ID");
					const input = parseApiTaskUpdate(await boundedJson(request, 65_536));
					return updateApiTask(
						pool,
						bearerToken(request.headers),
						params.id,
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.get(
			"/api/v1/lists/:id/deletion-observation",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid list ID");
					return withPersonalAccessToken(
						pool,
						bearerToken(request.headers),
						"read",
						(client, actor) =>
							readApiListDeletionObservation(client, actor, params.id),
					);
				}),
		)
		.delete(
			"/api/v1/lists/:id",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid list ID");
					const input = parseApiListDelete(await boundedJson(request));
					return deleteApiList(
						pool,
						bearerToken(request.headers),
						params.id,
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.get("/api/v1/lists/:id/observation", ({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (!PUBLIC_API_ID.safeParse(params.id).success)
					throw new PublicApiError(400, "invalid-id", "Invalid list ID");
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					(client, actor) => readApiListObservation(client, actor, params.id),
				);
			}),
		)
		.patch(
			"/api/v1/lists/:id",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid list ID");
					const input = parseApiListUpdate(await boundedJson(request));
					return updateApiList(
						pool,
						bearerToken(request.headers),
						params.id,
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.post(
			"/api/v1/lists",
			({ request, server }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					const input = parseApiListCreate(await boundedJson(request));
					return writeApiList(
						pool,
						bearerToken(request.headers),
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.post("/api/v1/tasks", ({ request, server }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (
					request.headers
						.get("content-type")
						?.split(";")[0]
						.trim()
						.toLowerCase() !== "application/json"
				)
					throw new PublicApiError(
						415,
						"unsupported-media-type",
						"A JSON request body is required",
					);
				const requestId = parseApiIdempotencyKey(
					request.headers.get("idempotency-key"),
				);
				const input = parseApiTaskCreate(await boundedJson(request, 65_536));
				return writeApiTask(
					pool,
					bearerToken(request.headers),
					input,
					requestId,
					flushEvents,
				);
			}),
		)
		.post("/api/v1/tasks/:id/complete", ({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (
					request.headers
						.get("content-type")
						?.split(";")[0]
						.trim()
						.toLowerCase() !== "application/json"
				)
					throw new PublicApiError(
						415,
						"unsupported-media-type",
						"A JSON request body is required",
					);
				const requestId = parseApiIdempotencyKey(
					request.headers.get("idempotency-key"),
				);
				if (!PUBLIC_API_ID.safeParse(params.id).success)
					throw new PublicApiError(400, "invalid-id", "Invalid task ID");
				const input = parseApiTaskComplete(await boundedJson(request));
				return completeApiTask(
					pool,
					bearerToken(request.headers),
					params.id,
					input,
					requestId,
				);
			}),
		)
		.get("/api/v1/folders/:id/observation", ({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (!PUBLIC_API_ID.safeParse(params.id).success)
					throw new PublicApiError(400, "invalid-id", "Invalid folder ID");
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					(client, actor) => readApiFolderObservation(client, actor, params.id),
				);
			}),
		)
		.post(
			"/api/v1/folders",
			({ request, server }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					const input = parseApiFolderCreate(await boundedJson(request));
					return writeApiFolder(
						pool,
						bearerToken(request.headers),
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.patch(
			"/api/v1/folders/:id",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid folder ID");
					const input = parseApiFolderUpdate(await boundedJson(request));
					return updateApiFolder(
						pool,
						bearerToken(request.headers),
						params.id,
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.delete(
			"/api/v1/folders/:id",
			({ request, server, params }) =>
				apiRequest(async () => {
					if (!(await rateLimit(request, server?.requestIP(request)?.address)))
						throw new PublicApiError(429, "rate-limited", "Too many requests");
					if (new URL(request.url).search)
						throw new PublicApiError(
							400,
							"invalid-query",
							"This endpoint has no query parameters",
						);
					if (
						request.headers
							.get("content-type")
							?.split(";")[0]
							.trim()
							.toLowerCase() !== "application/json"
					)
						throw new PublicApiError(
							415,
							"unsupported-media-type",
							"A JSON request body is required",
						);
					const requestId = parseApiIdempotencyKey(
						request.headers.get("idempotency-key"),
					);
					if (!PUBLIC_API_ID.safeParse(params.id).success)
						throw new PublicApiError(400, "invalid-id", "Invalid folder ID");
					const input = parseApiFolderDelete(await boundedJson(request));
					return deleteApiFolder(
						pool,
						bearerToken(request.headers),
						params.id,
						input,
						requestId,
					);
				}),
			{ parse: "none" },
		)
		.get("/api/v1/openapi.json", () =>
			Response.json(publicApiOpenApi(), {
				headers: {
					"cache-control": "public, max-age=3600",
					"x-content-type-options": "nosniff",
				},
			}),
		)
		.get("/api/v1/me", ({ request, server }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					readApiProfile,
				);
			}),
		);
	app.get("/api/v1/tasks/:id/comments", ({ request, server, params }) =>
		apiRequest(async () => {
			if (!(await rateLimit(request, server?.requestIP(request)?.address)))
				throw new PublicApiError(429, "rate-limited", "Too many requests");
			if (!apiCommentIdSchema.safeParse(params.id).success)
				throw new PublicApiError(400, "invalid-id", "Invalid task ID");
			const query = parseCommentPageQuery(new URL(request.url), params.id);
			return withPersonalAccessToken(
				pool,
				bearerToken(request.headers),
				"read",
				(client, actor) => readApiComments(client, actor, params.id, query),
			);
		}),
	);
	app.get(
		"/api/v1/tasks/:id/comments/:commentId/observation",
		({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (
					!apiCommentIdSchema.safeParse(params.id).success ||
					!apiCommentIdSchema.safeParse(params.commentId).success
				)
					throw new PublicApiError(
						400,
						"invalid-id",
						"Invalid comment or task ID",
					);
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					(client, actor) =>
						readApiCommentObservation(
							client,
							actor,
							params.id,
							params.commentId,
						),
				);
			}),
	);
	app.post(
		"/api/v1/tasks/:id/comments",
		({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (
					request.headers
						.get("content-type")
						?.split(";")[0]
						.trim()
						.toLowerCase() !== "application/json"
				)
					throw new PublicApiError(
						415,
						"unsupported-media-type",
						"A JSON request body is required",
					);
				if (!apiCommentIdSchema.safeParse(params.id).success)
					throw new PublicApiError(400, "invalid-id", "Invalid task ID");
				const requestId = parseApiIdempotencyKey(
					request.headers.get("idempotency-key"),
				);
				return writeApiComment(
					pool,
					bearerToken(request.headers),
					"create",
					params.id,
					null,
					parseApiCommentCreate(await boundedJson(request, 65536)),
					requestId,
					flushEvents,
				);
			}),
		{ parse: "none" },
	);
	app.patch(
		"/api/v1/tasks/:id/comments/:commentId",
		({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (
					request.headers
						.get("content-type")
						?.split(";")[0]
						.trim()
						.toLowerCase() !== "application/json"
				)
					throw new PublicApiError(
						415,
						"unsupported-media-type",
						"A JSON request body is required",
					);
				if (
					!apiCommentIdSchema.safeParse(params.id).success ||
					!apiCommentIdSchema.safeParse(params.commentId).success
				)
					throw new PublicApiError(
						400,
						"invalid-id",
						"Invalid comment or task ID",
					);
				const requestId = parseApiIdempotencyKey(
					request.headers.get("idempotency-key"),
				);
				return writeApiComment(
					pool,
					bearerToken(request.headers),
					"update",
					params.id,
					params.commentId,
					parseApiCommentUpdate(await boundedJson(request, 65536)),
					requestId,
				);
			}),
		{ parse: "none" },
	);
	app.delete(
		"/api/v1/tasks/:id/comments/:commentId",
		({ request, server, params }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				if (
					request.headers
						.get("content-type")
						?.split(";")[0]
						.trim()
						.toLowerCase() !== "application/json"
				)
					throw new PublicApiError(
						415,
						"unsupported-media-type",
						"A JSON request body is required",
					);
				if (
					!apiCommentIdSchema.safeParse(params.id).success ||
					!apiCommentIdSchema.safeParse(params.commentId).success
				)
					throw new PublicApiError(
						400,
						"invalid-id",
						"Invalid comment or task ID",
					);
				const requestId = parseApiIdempotencyKey(
					request.headers.get("idempotency-key"),
				);
				return writeApiComment(
					pool,
					bearerToken(request.headers),
					"delete",
					params.id,
					params.commentId,
					parseApiCommentDelete(await boundedJson(request)),
					requestId,
				);
			}),
		{ parse: "none" },
	);
	for (const resource of PUBLIC_API_RESOURCES) {
		app.get(`/api/v1/${resource}`, ({ request, server }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				const query = parsePageQuery(new URL(request.url), resource);
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					(client, actor) => readApiResource(client, actor, resource, query),
				);
			}),
		);
		app.get(`/api/v1/${resource}/:id`, ({ request, params, server }) =>
			apiRequest(async () => {
				if (!(await rateLimit(request, server?.requestIP(request)?.address)))
					throw new PublicApiError(429, "rate-limited", "Too many requests");
				if (new URL(request.url).search)
					throw new PublicApiError(
						400,
						"invalid-query",
						"This endpoint has no query parameters",
					);
				return withPersonalAccessToken(
					pool,
					bearerToken(request.headers),
					"read",
					(client, actor) =>
						readApiResource(
							client,
							actor,
							resource,
							{
								limit: 1,
								after: null,
								workspaceId: null,
								listId: null,
								done: null,
							},
							params.id,
						),
				);
			}),
		);
	}
	return app;
}
