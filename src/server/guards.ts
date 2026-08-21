import type { auth } from "../auth/auth.ts";
import { requireSameOrigin } from "../auth/security.ts";

// Same-origin + session, the shape every authenticated route here shares.
// Extracted from index.ts so route groups can reuse it without importing the
// app they are mounted into, which would be a cycle.
//
// Deliberately NOT applied to the ack route (C24): that one is reached by push
// clients with no session and, from ntfy's web UI, cross-origin.
export type Session = NonNullable<
	Awaited<ReturnType<typeof auth.api.getSession>>
>;

export type Guards = {
	// Exposed because the invite-preview route is a deliberate exception: a
	// session-less GET that must still refuse a present-and-foreign origin.
	foreignOrigin: (request: Request) => boolean;
	guardedPost: (
		handler: (request: Request, session: Session) => Promise<unknown>,
	) => (context: { request: Request }) => Promise<unknown>;
	guardedGet: (
		handler: (request: Request, session: Session) => Promise<unknown>,
	) => (context: { request: Request }) => Promise<unknown>;
};

export function makeGuards(
	requestOrigins: string[],
	getSession: (headers: Headers) => Promise<Session | null>,
): Guards {
	// A same-origin GET carries no Origin header at all, so only a
	// present-and-foreign origin is refused. Writes use the stricter check.
	const foreignOrigin = (request: Request): boolean => {
		const origin = request.headers.get("origin");
		return (
			origin !== null &&
			!requestOrigins.some((o) => new URL(o).origin === origin)
		);
	};

	return {
		foreignOrigin,
		guardedPost(handler) {
			return async ({ request }) => {
				try {
					requireSameOrigin(request, requestOrigins);
				} catch {
					return new Response("Forbidden", { status: 403 });
				}
				const session = await getSession(request.headers);
				if (!session) return new Response("Unauthorized", { status: 401 });
				return await handler(request, session);
			};
		},
		guardedGet(handler) {
			return async ({ request }) => {
				if (foreignOrigin(request))
					return new Response("Forbidden", { status: 403 });
				const session = await getSession(request.headers);
				if (!session) return new Response("Unauthorized", { status: 401 });
				return await handler(request, session);
			};
		},
	};
}
