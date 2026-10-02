import { Elysia } from "elysia";
import type { Pool } from "pg";
import type { db as defaultDb } from "../../db/client.ts";
import { UserContextError } from "../../db/user-context.ts";
import { type E2EGuards, e2eRoutes } from "../e2e/routes.ts";
import { authenticateNative } from "./session.ts";

export type NativeE2EDependencies = {
	pool: Pool;
	database: typeof defaultDb;
	rateLimit: (request: Request, peerAddress?: string) => Promise<boolean>;
};

const NO_STORE = { "cache-control": "no-store" };

function reply(
	code: string,
	status: number,
	headers: Record<string, string> = {},
): Response {
	return Response.json(
		{ code },
		{ status, headers: { ...NO_STORE, ...headers } },
	);
}

// Plain JSON outputs are wrapped; Responses keep their status and headers, and
// are copied so the no-store header never lands on an immutable instance.
function finish(result: unknown): Response {
	if (result instanceof Response) {
		const response = new Response(result.body, result);
		response.headers.set("cache-control", "no-store");
		return response;
	}
	return Response.json(result, { headers: NO_STORE });
}

export function nativeE2ERoutes(deps: NativeE2EDependencies) {
	const peers = new WeakMap<Request, string>();

	// The same encryption handlers as the browser API, behind the native
	// verifier. The principal is built from the verified session and carries
	// nothing else; there is no cookie, Origin, or browser session on this path.
	const guard =
		(handler: Parameters<E2EGuards["guardedGet"]>[0]) =>
		async ({ request }: { request: Request }): Promise<Response> => {
			if (request.headers.has("origin") || request.headers.has("cookie"))
				return reply("credentials-not-allowed", 400);
			try {
				if (!(await deps.rateLimit(request, peers.get(request))))
					return reply("rate-limited", 429, { "retry-after": "5" });
				const session = await authenticateNative(deps.pool, request.headers);
				if (!session) return reply("unauthorized", 401);
				return finish(await handler(request, { user: { id: session.userId } }));
			} catch (error) {
				if (error instanceof UserContextError)
					return reply("unauthorized", 401);
				// Category only: request bodies and key material never reach a log.
				console.error("native e2e request failed");
				return reply("native-e2e-failed", 500);
			}
		};

	return new Elysia()
		.onError(() => {
			console.error("native e2e request failed");
			return reply("native-e2e-failed", 500);
		})
		.onRequest(({ request, server }) => {
			const peerAddress = server?.requestIP(request)?.address;
			if (peerAddress) peers.set(request, peerAddress);
		})
		.use(
			e2eRoutes(
				deps.pool,
				deps.database,
				{ guardedGet: guard, guardedPost: guard },
				"/api/native/e2e",
			),
		);
}
