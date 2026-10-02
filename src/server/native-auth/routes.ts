import { Elysia } from "elysia";
import type { Pool } from "pg";
import type { Guards } from "../guards.ts";
import {
	bootstrapNativeWorkspace,
	readBootstrapBody,
	readNativeProfile,
} from "./application.ts";
import {
	hasAmbientCredentials,
	isCanonicalId,
	parseApprove,
	parseCreate,
	parseExchange,
	readJsonObject,
	type Sessions,
} from "./contracts.ts";
import { authenticateNative, type NativeSession } from "./session.ts";
import { NativeExchangeError, NativeGrantStore } from "./store.ts";

export type NativeAuthDependencies = {
	pool: Pool;
	sessions: Sessions;
	guards: Pick<Guards, "guardedPost" | "guardedGet">;
	rateLimit: (request: Request, peerAddress?: string) => Promise<boolean>;
	signZeroToken: (session: NativeSession) => Promise<string>;
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

function ok(body: unknown): Response {
	return Response.json(body, { headers: NO_STORE });
}

const limited = () => reply("rate-limited", 429, { "retry-after": "5" });

export function nativeAuthRoutes(deps: NativeAuthDependencies) {
	const store = new NativeGrantStore(deps.pool, deps.sessions);
	const peers = new WeakMap<Request, string>();
	const rateLimit = (request: Request) =>
		deps.rateLimit(request, peers.get(request));

	// Guard rejections (403/401) are built outside this module, so the no-store
	// header is applied here rather than assumed.
	const noStore = (response: unknown): unknown => {
		if (response instanceof Response)
			response.headers.set("cache-control", "no-store");
		return response;
	};

	const approve = deps.guards.guardedPost(async (request, session) => {
		if (request.headers.has("authorization"))
			return reply("credentials-not-allowed", 400);
		if (!(await rateLimit(request))) return limited();
		const body = await readJsonObject(request);
		if (!body.ok) return reply("invalid-request", body.status);
		const input = parseApprove(body.value);
		if (!input) return reply("invalid-request", 400);
		const outcome = await store.approve(
			input.grantId,
			session.user.id,
			session.session.id,
		);
		if (outcome === "busy") return reply("busy", 503, { "retry-after": "2" });
		if (outcome !== "approved") return reply("invalid-grant", 400);
		return ok({ approved: true });
	});
	const preview = deps.guards.guardedGet(async (request, session) => {
		if (request.headers.has("authorization"))
			return reply("credentials-not-allowed", 400);
		if (!(await rateLimit(request))) return limited();
		const ids = new URL(request.url).searchParams.getAll("grantId");
		if (ids.length !== 1 || !isCanonicalId(ids[0]))
			return reply("invalid-request", 400);
		const grant = await store.preview(
			ids[0],
			session.user.id,
			session.session.id,
		);
		if (!grant) return reply("invalid-grant", 404);
		return ok({ ...grant, expiresAt: grant.expiresAt.toISOString() });
	});

	return new Elysia()
		.onError(() => {
			console.error("native auth request failed");
			return reply("native-auth-failed", 500);
		})
		.onRequest(({ request, server }) => {
			const peerAddress = server?.requestIP(request)?.address;
			if (peerAddress) peers.set(request, peerAddress);
		})
		.get("/api/native/grants/preview", async (context) =>
			noStore(await preview(context)),
		)
		.post(
			"/api/native/grants",
			async ({ request }) => {
				if (hasAmbientCredentials(request.headers))
					return reply("credentials-not-allowed", 400);
				if (!(await rateLimit(request))) return limited();
				const body = await readJsonObject(request);
				if (!body.ok) return reply("invalid-request", body.status);
				const input = parseCreate(body.value);
				if (!input) return reply("invalid-request", 400);
				await store.prune().catch(() => {
					console.error("native grant prune failed");
				});
				const created = await store.create(input.challenge, input.deviceLabel);
				return ok({
					grantId: created.grantId,
					expiresAt: created.expiresAt.toISOString(),
				});
			},
			{ parse: "none" },
		)
		.post(
			"/api/native/grants/approve",
			async (context) => noStore(await approve(context)),
			{ parse: "none" },
		)
		.post(
			"/api/native/grants/exchange",
			async ({ request }) => {
				if (hasAmbientCredentials(request.headers))
					return reply("credentials-not-allowed", 400);
				if (!(await rateLimit(request))) return limited();
				const body = await readJsonObject(request);
				if (!body.ok) return reply("invalid-request", body.status);
				const input = parseExchange(body.value);
				if (!input) return reply("invalid-request", 400);
				try {
					const result = await store.exchange(input.grantId, input.verifier);
					if (result.kind === "busy")
						return reply("busy", 503, { "retry-after": "2" });
					if (result.kind === "pending")
						return reply("authorization-pending", 409);
					if (result.kind === "invalid") return reply("invalid-grant", 400);
					return ok({
						token: result.token,
						sessionId: result.sessionId,
						userId: result.userId,
						deviceId: result.deviceId,
						expiresAt: result.expiresAt.toISOString(),
					});
				} catch (error) {
					// Category only: neither the token nor the verifier is ever logged.
					console.error("native exchange failed", {
						cleanupFailed:
							error instanceof NativeExchangeError && error.cleanupFailed,
					});
					return reply("exchange-failed", 500);
				}
			},
			{ parse: "none" },
		)
		.get("/api/native/session", async ({ request }) => {
			if (request.headers.has("origin") || request.headers.has("cookie"))
				return reply("credentials-not-allowed", 400);
			if (!(await rateLimit(request))) return limited();
			const session = await authenticateNative(deps.pool, request.headers);
			if (!session) return reply("unauthorized", 401);
			return ok({
				sessionId: session.sessionId,
				userId: session.userId,
				deviceId: session.deviceId,
				deviceLabel: session.deviceLabel,
				expiresAt: session.expiresAt.toISOString(),
				firstSeenAt: session.firstSeenAt.toISOString(),
				lastSeenAt: session.lastSeenAt.toISOString(),
			});
		})
		.get("/api/native/profile", async ({ request }) => {
			if (request.headers.has("origin") || request.headers.has("cookie"))
				return reply("credentials-not-allowed", 400);
			if (!(await rateLimit(request))) return limited();
			const session = await authenticateNative(deps.pool, request.headers);
			if (!session) return reply("unauthorized", 401);
			const profile = await readNativeProfile(deps.pool, session);
			if (!profile) return reply("unauthorized", 401);
			return ok(profile);
		})
		.post(
			"/api/native/bootstrap",
			async ({ request }) => {
				if (request.headers.has("origin") || request.headers.has("cookie"))
					return reply("credentials-not-allowed", 400);
				if (!(await rateLimit(request))) return limited();
				const session = await authenticateNative(deps.pool, request.headers);
				if (!session) return reply("unauthorized", 401);
				const body = await readBootstrapBody(request);
				if (!body.ok) return reply("invalid-request", body.status);
				const workspaceId = await bootstrapNativeWorkspace(deps.pool, session);
				if (!workspaceId) return reply("unauthorized", 401);
				return ok({ workspaceId });
			},
			{ parse: "none" },
		)
		.get("/api/native/token", async ({ request }) => {
			if (request.headers.has("origin") || request.headers.has("cookie"))
				return reply("credentials-not-allowed", 400);
			if (!(await rateLimit(request))) return limited();
			const session = await authenticateNative(deps.pool, request.headers);
			if (!session) return reply("unauthorized", 401);
			return ok({ token: await deps.signZeroToken(session) });
		});
}
