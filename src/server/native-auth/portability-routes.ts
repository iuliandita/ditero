import { Elysia } from "elysia";
import type { Pool } from "pg";
import { UserContextError } from "../../db/user-context.ts";
import {
	ImportPlanStoreError,
	listCompletedAttachmentImportJobs,
} from "../portability/import-plan-store.ts";
import {
	createAttachmentMigrationHandlers,
	createImportAdmission,
} from "../portability/import-routes.ts";
import type { PortabilityExporter } from "../portability/routes.ts";
import { authenticateNative } from "./session.ts";

export function nativePortabilityRoutes(deps: {
	pool: Pool;
	admission?: Set<string>;
	exporter: PortabilityExporter;
	rateLimit: (request: Request, peerAddress?: string) => Promise<boolean>;
}): Elysia {
	const peers = new WeakMap<Request, string>();
	const reply = (
		code: string,
		status: number,
		headers: Record<string, string> = {},
	) =>
		Response.json(
			{ code },
			{
				status,
				headers: {
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					...headers,
				},
			},
		);
	const migration = createAttachmentMigrationHandlers(
		deps.pool,
		deps.admission ?? createImportAdmission(),
		true,
	);
	const guard =
		(handler: (request: Request, ownerId: string) => Promise<unknown>) =>
		async ({ request }: { request: Request }) => {
			if (request.headers.has("origin") || request.headers.has("cookie"))
				return reply("credentials-not-allowed", 400);
			try {
				if (!(await deps.rateLimit(request, peers.get(request))))
					return reply("rate-limited", 429, { "retry-after": "5" });
				const session = await authenticateNative(deps.pool, request.headers);
				if (!session) return reply("unauthorized", 401);
				if (request.method === "GET" && request.body !== null)
					return reply("invalid-request", 400);
				return await handler(request, session.userId);
			} catch (error) {
				if (error instanceof UserContextError)
					return reply("unauthorized", 401);
				if (error instanceof ImportPlanStoreError)
					return reply(error.code, error.status);
				console.error("native migration request failed");
				return reply("migration-failed", 500);
			}
		};

	const app = new Elysia();
	app
		.onRequest(({ request, server }) => {
			const peer = server?.requestIP(request)?.address;
			if (peer) peers.set(request, peer);
		})
		.get("/api/native/portability/export", async ({ request }) => {
			if (request.headers.has("origin") || request.headers.has("cookie"))
				return reply("credentials-not-allowed", 400);
			try {
				if (!(await deps.rateLimit(request, peers.get(request))))
					return reply("rate-limited", 429, { "retry-after": "5" });
				const session = await authenticateNative(deps.pool, request.headers);
				if (!session) return reply("unauthorized", 401);
				return await deps.exporter(request, session.userId, 2);
			} catch (error) {
				if (error instanceof UserContextError)
					return reply("unauthorized", 401);
				console.error("native portability request failed");
				return reply("export-failed", 500);
			}
		});
	app
		.get(
			"/api/native/portability/import/jobs",
			guard(async (request, ownerId) => {
				const query: { afterJobId?: string; limit: number } = { limit: 64 };
				const seen = new Set<string>();
				for (const [key, value] of new URL(request.url).searchParams) {
					if (seen.has(key) || !["afterJobId", "limit"].includes(key))
						return reply("invalid-migration-jobs", 400);
					seen.add(key);
					if (key === "afterJobId") {
						if (!/^[a-f0-9]{64}$/.test(value))
							return reply("invalid-migration-jobs", 400);
						query.afterJobId = value;
					} else {
						if (!/^[1-9][0-9]*$/.test(value) || Number(value) > 64)
							return reply("invalid-migration-jobs", 400);
						query.limit = Number(value);
					}
				}
				return Response.json(
					await listCompletedAttachmentImportJobs(
						deps.pool,
						ownerId,
						query,
						request.signal,
					),
					{
						headers: {
							"cache-control": "no-store",
							"x-content-type-options": "nosniff",
						},
					},
				);
			}),
		)
		.get(
			"/api/native/portability/import/plans/:id/attachment-parents",
			guard(migration.parents),
		)
		.get(
			"/api/native/portability/import/plans/:id/attachment-migrations",
			guard(migration.inspect),
		)
		.get(
			"/api/native/portability/import/plans/:id/attachment-reservations",
			guard(migration.status),
		)
		.post(
			"/api/native/portability/import/plans/:id/attachment-reservations",
			guard(migration.reserve),
			{ parse: "none" },
		)
		.post(
			"/api/native/portability/import/plans/:id/attachment-recoveries",
			guard(migration.recover),
			{ parse: "none" },
		);
	return app;
}
