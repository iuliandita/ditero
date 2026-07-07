// App API: Better Auth (+ JWKS) + Zero synced-query and mutate endpoints.
// Read permission is enforced in /api/zero/query (filtered queries); write
// permission runs inside each mutator, driven by /api/zero/mutate.
import { join } from "node:path";
import { cors } from "@elysiajs/cors";
import { mustGetMutator, mustGetQuery } from "@rocicorp/zero";
import { handleMutateRequest, handleQueryRequest } from "@rocicorp/zero/server";
import { zeroNodePg } from "@rocicorp/zero/server/adapters/pg";
import { Elysia } from "elysia";
import { auth } from "../auth/auth.ts";
import { pool } from "../db/client.ts";
import { mutators } from "../zero/mutators.ts";
import { queries } from "../zero/queries.ts";
import { schema } from "../zero/schema.gen.ts";
import { ctxFromAuthHeader } from "./ctx.ts";

const PORT = Number(process.env.API_PORT ?? 3000);
// Deny by default: no/invalid token -> a ctx id that matches no rows and
// fails every role gate. Never let a missing token through as a real user.
const NOBODY = { id: "__nobody__" };

// Shared write DB provider (the ZQLDatabase path handleMutateRequest drives).
const zdb = zeroNodePg(schema, pool);

const routes = new Elysia()
	.use(cors())
	.get("/health", () => ({ ok: true }))
	// Better Auth catch-all: serves JWKS (GET) and all auth POSTs.
	.all("/api/auth/*", ({ request }) => auth.handler(request))
	// Zero synced-query endpoint. zero-cache POSTs here; we authenticate and
	// return filtered queries so only permitted rows sync.
	.post("/api/zero/query", async ({ request }) => {
		const ctx = await ctxFromAuthHeader(request.headers.get("Authorization"));
		const result = await handleQueryRequest({
			handler: (name: string, args: unknown) => {
				const q = mustGetQuery(queries, name);
				return q.fn({ args: args as never, ctx: ctx ?? NOBODY });
			},
			schema,
			request,
			userID: ctx?.id,
		});
		return result instanceof Response ? result : Response.json(result);
	})
	// Zero mutate endpoint. Authorization runs inside each mutator server-side;
	// an unauthenticated push carries the NOBODY ctx and is rejected there.
	.post("/api/zero/mutate", async ({ request }) => {
		const ctx = await ctxFromAuthHeader(request.headers.get("Authorization"));
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
					await m.fn({ tx, ctx: ctx ?? NOBODY, args });
				}),
			request,
			userID: ctx?.id,
		});
		return result instanceof Response ? result : Response.json(result);
	});

// Prod (SERVE_STATIC_DIR set): serve the built web same-origin so web and API
// share one port (no CORS/trustedOrigins needed). Runs from the NOT_FOUND hook
// so it only handles routes the API didn't — it never shadows /api/* or /health.
// SPA fallback: unknown non-API GETs return index.html for client-side routing.
// Dev leaves SERVE_STATIC_DIR unset and vite serves the web.
const staticDir = process.env.SERVE_STATIC_DIR;
const app = (
	staticDir
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
		: routes
).listen(PORT);

console.log(`ditero api on :${PORT}`);

export type App = typeof app;
