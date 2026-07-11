// App API: Better Auth (+ JWKS) + Zero synced-query and mutate endpoints.
// Read permission is enforced in /api/zero/query (filtered queries); write
// permission runs inside each mutator, driven by /api/zero/mutate.
import { join } from "node:path";
import { cors } from "@elysiajs/cors";
import { mustGetMutator, mustGetQuery } from "@rocicorp/zero";
import { handleMutateRequest, handleQueryRequest } from "@rocicorp/zero/server";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Elysia } from "elysia";
import { auth, handleAuthRequest } from "../auth/auth.ts";
import { ensurePersonalWorkspace } from "../auth/bootstrap.ts";
import { trustedAuthOrigins } from "../auth/origins.ts";
import { requireSameOrigin } from "../auth/security.ts";
import { pool } from "../db/client.ts";
import { verifyRuntimeDatabaseRole } from "../db/runtime-role.ts";
import { mutators } from "../zero/mutators.ts";
import { queries } from "../zero/queries.ts";
import { schema } from "../zero/schema.gen.ts";
import { ctxFromAuthHeader } from "./ctx.ts";
import { corsPolicy, securityHeaders } from "./http-policy.ts";

const PORT = Number(process.env.API_PORT ?? 3000);
const responseHeaders = securityHeaders(process.env);
const requestOrigins = [
	process.env.BETTER_AUTH_URL ?? `http://localhost:${PORT}`,
	...trustedAuthOrigins(process.env),
];

// Shared write DB provider (the ZQLDatabase path handleMutateRequest drives).
const zdb = zeroNodePg(schema, pool);

const routes = new Elysia()
	.use(cors(corsPolicy(process.env)))
	.onRequest(({ set }) => {
		Object.assign(set.headers, responseHeaders);
	})
	.get("/health", () => ({ ok: true }))
	// Better Auth catch-all: serves JWKS (GET) and all auth POSTs.
	.all("/api/auth/*", ({ request, server }) =>
		handleAuthRequest(request, server?.requestIP(request)?.address),
	)
	.post("/api/bootstrap", async ({ request }) => {
		try {
			requireSameOrigin(request, requestOrigins);
		} catch {
			return new Response("Forbidden", { status: 403 });
		}
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) return new Response("Unauthorized", { status: 401 });
		const workspaceId = await ensurePersonalWorkspace(session.user);
		return { workspaceId };
	})
	// Zero synced-query endpoint. zero-cache POSTs here; we authenticate and
	// return filtered queries so only permitted rows sync.
	.post("/api/zero/query", async ({ request }) => {
		const ctx = await ctxFromAuthHeader(request.headers.get("Authorization"));
		if (!ctx) return new Response("Unauthorized", { status: 401 });
		const result = await handleQueryRequest({
			handler: (name: string, args: unknown) => {
				const q = mustGetQuery(queries, name);
				return q.fn({ args: args as never, ctx });
			},
			schema,
			request,
			userID: ctx.id,
		});
		return result instanceof Response ? result : Response.json(result);
	})
	// Zero mutate endpoint. Authentication is rejected here; authorization runs
	// inside each mutator server-side.
	.post("/api/zero/mutate", async ({ request }) => {
		const ctx = await ctxFromAuthHeader(request.headers.get("Authorization"));
		if (!ctx) return new Response("Unauthorized", { status: 401 });
		const result = await handleMutateRequest({
			dbProvider: zdb,
			handler: (transact) =>
				transact(async (tx: unknown, name: string, args: unknown) => {
					const m = mustGetMutator(mutators, name) as {
						fn: (a: {
							tx: unknown;
							ctx: { id: string };
							args: unknown;
						}) => Promise<void>;
					};
					await m.fn({ tx, ctx, args });
				}),
			request,
			userID: ctx.id,
		});
		return result instanceof Response ? result : Response.json(result);
	});

// Prod (SERVE_STATIC_DIR set): serve the built web same-origin so web and API
// share one port (no CORS/trustedOrigins needed). Runs from the NOT_FOUND hook
// so it only handles routes the API didn't — it never shadows /api/* or /health.
// SPA fallback: unknown non-API GETs return index.html for client-side routing.
// Dev leaves SERVE_STATIC_DIR unset and vite serves the web.
const staticDir = process.env.SERVE_STATIC_DIR;
const app = staticDir
	? routes.onError(async ({ code, request }) => {
			if (code !== "NOT_FOUND") return;
			const { pathname } = new URL(request.url);
			// Return explicit Responses so the 200 isn't overridden by the
			// NOT_FOUND status Elysia's error hook would otherwise apply.
			if (pathname.startsWith("/api/")) {
				return new Response("Not Found", { status: 404 });
			}
			const rel = pathname.replace(/^\/+/, "");
			if (rel) {
				const asset = Bun.file(join(staticDir, rel));
				if (await asset.exists()) {
					return new Response(asset, {
						headers: { "content-type": asset.type },
					});
				}
			}
			// SPA fallback: unknown non-API GET -> client-side routing.
			const index = Bun.file(join(staticDir, "index.html"));
			return new Response(index, {
				headers: { "content-type": index.type },
			});
		})
	: routes;

if (import.meta.main) {
	if (process.env.NODE_ENV === "production") {
		await verifyRuntimeDatabaseRole(pool);
	}
	app.listen(PORT);
	console.log(`ditero api on :${PORT}`);
}

export type App = typeof app;
export { app };
