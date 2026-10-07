import { Elysia } from "elysia";
import type { Pool } from "pg";
import { UserContextError } from "../../db/user-context.ts";
import type { PortabilityExporter } from "../portability/routes.ts";
import { authenticateNative } from "./session.ts";

export function nativePortabilityRoutes(deps: {
	pool: Pool;
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
			{ status, headers: { "cache-control": "no-store", ...headers } },
		);
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
	return app;
}
