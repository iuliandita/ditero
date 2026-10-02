import { Elysia } from "elysia";
import type { Pool } from "pg";
import { UserContextError } from "../../db/user-context.ts";
import {
	type AttachmentGuards,
	type AttachmentRouteOptions,
	attachmentRoutes,
} from "../attachments/routes.ts";
import type { BlobStore } from "../storage/blob-store.ts";
import { readJsonObject } from "./contracts.ts";
import { authenticateNative } from "./session.ts";

export type NativeAttachmentDependencies = {
	pool: Pool;
	store: BlobStore;
	options?: AttachmentRouteOptions;
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

export function nativeAttachmentRoutes(
	deps: NativeAttachmentDependencies,
): Elysia {
	const peers = new WeakMap<Request, string>();

	const guard =
		(handler: Parameters<AttachmentGuards["guardedGet"]>[0]) =>
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
				console.error("native attachment request failed");
				return reply("native-attachment-failed", 500);
			}
		};

	// Keep this native plugin out of the browser route type expansion.
	const app = new Elysia();
	app
		.onError(() => {
			console.error("native attachment request failed");
			return reply("native-attachment-failed", 500);
		})
		.onRequest(({ request, server }) => {
			const peerAddress = server?.requestIP(request)?.address;
			if (peerAddress) peers.set(request, peerAddress);
		})
		.use(
			attachmentRoutes(
				deps.pool,
				{ guardedGet: guard, guardedPost: guard },
				deps.store,
				{
					...deps.options,
					// Three 64 KiB opaque fields may expand sixfold as JSON escapes.
					readJson: (request) => readJsonObject(request, 2 * 1024 * 1024),
				},
				"/api/native/attachments",
			),
		);
	return app;
}
