import { Elysia } from "elysia";
import type { Pool } from "pg";
import { z } from "zod";
import { UserContextError } from "../../db/user-context.ts";
import {
	apiResult,
	PublicApiError,
	publicApiProblem,
} from "../../domain/public-api.ts";
import type { Guards } from "../guards.ts";
import {
	bearerToken,
	PUBLIC_API_RESOURCES,
	parsePageQuery,
} from "./contracts.ts";
import { publicApiOpenApi } from "./openapi.ts";
import { readApiProfile, readApiResource } from "./read.ts";
import {
	createPersonalAccessToken,
	listPersonalAccessTokens,
	revokePersonalAccessToken,
	withPersonalAccessToken,
} from "./tokens.ts";

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
			(error.code === "55P03" || error.code === "57014")
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

async function boundedJson(request: Request): Promise<unknown> {
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
			if (bytes > 4096) {
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
			return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

export function publicApiRoutes(pool: Pool, rateLimit: RateLimit) {
	const app = new Elysia()
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
