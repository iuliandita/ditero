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

// Prod (SERVE_STATIC_DIR set): serve the built web same-origin with an SPA
// fallback, so web and API share one port (no CORS/trustedOrigins needed).
// The /health + /api/* routes above are matched first; only non-API GETs reach
// this catch-all. Dev leaves SERVE_STATIC_DIR unset and vite serves the web.
const staticDir = process.env.SERVE_STATIC_DIR;
const app = (
	staticDir
		? routes.get("/*", async ({ request, set }) => {
				const { pathname } = new URL(request.url);
				if (pathname.startsWith("/api/") || pathname === "/health") {
					set.status = 404;
					return "Not Found";
				}
				const rel = pathname.replace(/^\/+/, "");
				const asset = rel ? Bun.file(join(staticDir, rel)) : null;
				if (asset && (await asset.exists())) return asset;
				return Bun.file(join(staticDir, "index.html"));
			})
		: routes
).listen(PORT);

console.log(`ditero api on :${PORT}`);

export type App = typeof app;
