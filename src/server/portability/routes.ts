import { Elysia } from "elysia";
import type { Pool } from "pg";
import { UserContextError } from "../../db/user-context.ts";
import type { Guards } from "../guards.ts";
import { serverErrorResponse } from "../server-error.ts";
import {
	acquirePortabilityConnection,
	PORTABILITY_CONCURRENCY,
	portabilityAdmission,
} from "./admission.ts";
import {
	ExportInterruptedError,
	ExportLimitError,
	type ExportOptions,
	exportPortableJson,
	exportPortableJsonV2,
	HistoryRequiresV2Error,
} from "./export.ts";

export function createPortabilityExporter(
	pool: Pool,
	options: ExportOptions = {},
) {
	const activeUsers = portabilityAdmission(pool);
	return async (
		request: Request,
		userId: string,
		version: 1 | 2,
	): Promise<Response> => {
		if (
			activeUsers.size >= PORTABILITY_CONCURRENCY ||
			activeUsers.has(userId)
		) {
			return Response.json(
				{ code: "export-busy" },
				{
					status: 429,
					headers: { "cache-control": "no-store", "retry-after": "5" },
				},
			);
		}
		const releaseConnection = acquirePortabilityConnection(pool, userId);
		if (!releaseConnection)
			return Response.json(
				{ code: "export-busy" },
				{
					status: 429,
					headers: { "cache-control": "no-store", "retry-after": "5" },
				},
			);
		activeUsers.add(userId);
		try {
			const exporter =
				version === 2 ? exportPortableJsonV2 : exportPortableJson;
			const body = await exporter(pool, userId, {
				...options,
				signal: request.signal,
			});
			return new Response(body, {
				headers: {
					"content-type": "application/json; charset=utf-8",
					"content-disposition":
						version === 2
							? 'attachment; filename="ditero-history-v2.json"'
							: 'attachment; filename="ditero-export-v1.json"',
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
				},
			});
		} catch (error) {
			if (error instanceof HistoryRequiresV2Error) {
				return Response.json(
					{ code: "history-requires-v2" },
					{ status: 409, headers: { "cache-control": "no-store" } },
				);
			}
			if (error instanceof ExportInterruptedError) {
				return Response.json(
					{ code: error.code },
					{
						status: error.code === "export-timeout" ? 503 : 408,
						headers: { "cache-control": "no-store" },
					},
				);
			}
			const status =
				error instanceof UserContextError
					? 401
					: error instanceof ExportLimitError
						? 413
						: 500;
			const code =
				status === 401
					? "unauthorized"
					: status === 413
						? "export-limit-exceeded"
						: "export-failed";
			if (status === 500) return serverErrorResponse(error, code);
			return Response.json(
				{ code },
				{ status, headers: { "cache-control": "no-store" } },
			);
		} finally {
			releaseConnection();
			activeUsers.delete(userId);
		}
	};
}

export type PortabilityExporter = ReturnType<typeof createPortabilityExporter>;

export function portabilityRoutes(
	pool: Pool,
	guards: Guards,
	options: ExportOptions = {},
	exporter: PortabilityExporter = createPortabilityExporter(pool, options),
) {
	return new Elysia().get(
		"/api/portability/export",
		guards.guardedGet(async (request, session) => {
			const versions = new URL(request.url).searchParams.getAll("version");
			if (
				versions.length > 1 ||
				(versions.length === 1 && !["1", "2"].includes(versions[0]))
			) {
				return Response.json(
					{ code: "unsupported-export-version" },
					{ status: 400, headers: { "cache-control": "no-store" } },
				);
			}
			const version = versions[0] === "2" ? 2 : 1;
			return exporter(request, session.user.id, version);
		}),
	);
}
