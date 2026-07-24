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
import {
	acceptInvite,
	InviteAcceptError,
	previewInvite,
} from "../auth/invite-accept.ts";
import { createInvite, InviteCreateError } from "../auth/invite-create.ts";
import {
	createManagedAccount,
	ManagedAccountError,
} from "../auth/managed-account.ts";
import { trustedAuthOrigins } from "../auth/origins.ts";
import { requireSameOrigin } from "../auth/security.ts";
import { mailConfig } from "../config/mail.ts";
import { notifyAllowedPrivateCIDRs } from "../config/notify-egress.ts";
import { workerTiming } from "../config/worker.ts";
import { db, pool } from "../db/client.ts";
import { verifyRuntimeDatabaseRole } from "../db/runtime-role.ts";
import { mutators } from "../zero/mutators.ts";
import { queries } from "../zero/queries.ts";
import { schema } from "../zero/schema.gen.ts";
import { ctxFromAuthHeader } from "./ctx.ts";
import { lookupUsers } from "./discovery.ts";
import { corsPolicy, securityHeaders } from "./http-policy.ts";
import { sendInviteMail } from "./mail/invite-mail.ts";
import { ackBaseUrl } from "./notifications/capability.ts";
import {
	ChannelError,
	channelCapabilities,
	deleteChannel,
	interactionsUrls,
	listChannels,
	saveChannel,
	testChannel,
} from "./notifications/channels.ts";
import { discordInteractionRoutes } from "./notifications/discord-interactions.ts";
import { createSendFn } from "./notifications/dispatch.ts";
import {
	eventMutateSession,
	startOverdueSweep,
} from "./notifications/events.ts";
import { ackRoutes } from "./notifications/routes.ts";
import { startScheduler } from "./notifications/scheduler.ts";
import { slackInteractionRoutes } from "./notifications/slack-interactions.ts";
import { startTelegramPoller } from "./notifications/telegram-poll.ts";
import { telegramWebhookRoutes } from "./notifications/telegram-webhook.ts";
import { startWorker } from "./notifications/worker.ts";

const PORT = Number(process.env.API_PORT ?? 3000);
const responseHeaders = securityHeaders(process.env);
const requestOrigins = [
	process.env.BETTER_AUTH_URL ?? `http://localhost:${PORT}`,
	...trustedAuthOrigins(process.env),
];

// Shared write DB provider (the ZQLDatabase path handleMutateRequest drives).
const zdb = zeroNodePg(schema, pool);

// Same-origin + session, the shape every authenticated POST here shares.
// Deliberately NOT applied to the ack route (C24): that one is reached by push
// clients with no session and, from ntfy's web UI, cross-origin.
type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

function guardedPost(
	handler: (request: Request, session: Session) => Promise<unknown>,
) {
	return async ({ request }: { request: Request }) => {
		try {
			requireSameOrigin(request, requestOrigins);
		} catch {
			return new Response("Forbidden", { status: 403 });
		}
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) return new Response("Unauthorized", { status: 401 });
		return await handler(request, session);
	};
}

// GET counterpart to guardedPost. Reads use the looser origin check rather
// than requireSameOrigin: a same-origin GET carries no Origin header at all, so
// only a present-and-foreign origin is refused.
function foreignOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");
	return (
		origin !== null && !requestOrigins.some((o) => new URL(o).origin === origin)
	);
}

function guardedGet(
	handler: (request: Request, session: Session) => Promise<unknown>,
) {
	return async ({ request }: { request: Request }) => {
		if (foreignOrigin(request))
			return new Response("Forbidden", { status: 403 });
		const session = await auth.api.getSession({ headers: request.headers });
		if (!session) return new Response("Unauthorized", { status: 401 });
		return await handler(request, session);
	};
}

// Shared JSON-body + ChannelError shape for the three channel writes. The body
// is the error's stable CODE, never its prose: the prose named deployment env
// vars ("set DITERO_PUBLIC_URL first") to non-admin users and could not be
// translated. The client maps the code through messages.ts.
async function channelWrite(
	request: Request,
	run: (body: unknown) => Promise<unknown>,
): Promise<unknown> {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
	try {
		return await run(body);
	} catch (error) {
		if (error instanceof ChannelError) {
			return new Response(error.code, { status: error.status });
		}
		throw error;
	}
}

const routes = new Elysia()
	// Public capability ack, mounted AHEAD of the global CORS plugin: the button
	// is pressed from ntfy's web UI, a genuine cross-origin request the global
	// policy rejects (and which `origin: false` rejects outright in production).
	// It carries no session or cookie, so its own permissive allowance is safe.
	.use(ackRoutes(db))
	// Same placement and the same reason: Telegram posts the callback with no
	// session and no Origin header, and the route authenticates itself with the
	// provider's secret-token header.
	.use(telegramWebhookRoutes(db))
	// Same placement and reason again: Discord posts interactions with no
	// session and no Origin header, authenticating with an Ed25519 signature.
	.use(discordInteractionRoutes(db))
	// Same placement and reason again: Slack posts interactions with no session
	// and no Origin header, authenticating with a v0 HMAC signature.
	.use(slackInteractionRoutes(db))
	.use(cors(corsPolicy(process.env)))
	.onRequest(({ set }) => {
		Object.assign(set.headers, responseHeaders);
	})
	// `replica` echoes DITERO_REPLICA_ID verbatim (null when unset) rather than
	// minting an identity here: startWorker resolves its own, and a second
	// random one would name a process nothing else answers to.
	.get("/health", () => ({
		ok: true,
		replica: process.env.DITERO_REPLICA_ID ?? null,
	}))
	// Better Auth catch-all: serves JWKS (GET) and all auth POSTs.
	.all("/api/auth/*", ({ request, server }) =>
		handleAuthRequest(request, server?.requestIP(request)?.address),
	)
	.post(
		"/api/bootstrap",
		guardedPost(async (_request, session) => {
			const workspaceId = await ensurePersonalWorkspace(session.user);
			return { workspaceId };
		}),
	)
	// Invite create: caller session; server generates + returns the token ONCE
	// (never synced). Role-escalation gate lives in createInvite.
	.post(
		"/api/invite/create",
		guardedPost(async (request, session) => {
			let body: Record<string, unknown>;
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				return new Response("Bad Request", { status: 400 });
			}
			if (
				typeof body.workspaceId !== "string" ||
				typeof body.role !== "string"
			) {
				return new Response("Bad Request", { status: 400 });
			}
			const email = (body.email as string | null | undefined) ?? null;
			try {
				const result = await createInvite(
					{
						workspaceId: body.workspaceId,
						role: body.role as never,
						email,
						expiresAt: (body.expiresAt as number | null | undefined) ?? null,
						// Only an explicit numeric cap is honored; otherwise leave undefined so
						// createInvite applies its default (email invite -> 1, link -> null).
						maxUses:
							typeof body.maxUses === "number" ? body.maxUses : undefined,
						attachTaskId:
							(body.attachTaskId as string | null | undefined) ?? null,
						attachKind: (body.attachKind as never) ?? null,
					},
					session.user.id,
					db,
				);
				// The invite exists either way; a mail problem is reported, never
				// raised. Rolling the row back over a dead SMTP server would destroy a
				// link that still works out-of-band.
				//
				// Awaited because the status is part of the response, so the send is
				// bounded instead: sendInviteMail's own deadline caps the wait, and the
				// signal drops it the moment the inviter gives up.
				const mail = await sendInviteMail(
					{
						email,
						token: result.token,
						workspaceId: body.workspaceId,
						inviterId: session.user.id,
					},
					{ database: db, signal: request.signal },
				);
				if (mail.status === "failed") {
					console.warn(
						`invite ${result.id}: mail not sent (${mail.category}, retryable=${mail.retryable})`,
					);
				}
				// { id, token, link } -- token returned once, not synced -- plus the
				// delivery status, so "I invited them" is not a silent lie.
				return { ...result, mail };
			} catch (error) {
				if (error instanceof InviteCreateError) {
					return new Response(error.message, { status: error.status });
				}
				throw error;
			}
		}),
	)
	// Invite accept: ALWAYS requires a session. A brand-new invitee signs up FIRST
	// (Task 6's email-invite bypass permits the signup), which authenticates them,
	// THEN calls this. So there is no unauthenticated accept path here.
	.post(
		"/api/invite/accept",
		guardedPost(async (request, session) => {
			let body: Record<string, unknown>;
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				return new Response("Bad Request", { status: 400 });
			}
			if (typeof body.token !== "string") {
				return new Response("Bad Request", { status: 400 });
			}
			try {
				return await acceptInvite(
					body.token,
					session.user.id,
					session.user.email,
					db,
				);
			} catch (error) {
				if (error instanceof InviteAcceptError) {
					// Distinct 4xx per reason; the token is never echoed back.
					const status =
						error.reason === "not_found"
							? 404
							: error.reason === "email_mismatch"
								? 403
								: 410;
					return new Response(error.reason, { status });
				}
				throw error;
			}
		}),
	)
	// Invite preview: minimal, pre-signup read. Returns ONLY {valid, workspaceName,
	// email}; never the token, role, or ids. Cross-origin requests are rejected;
	// same-origin (no Origin header) is allowed so the signup screen can read it.
	.get("/api/invite/preview", async ({ request }) => {
		if (foreignOrigin(request))
			return new Response("Forbidden", { status: 403 });
		const token = new URL(request.url).searchParams.get("token");
		if (!token) return { valid: false };
		return await previewInvite(token, db);
	})
	// Managed ("kid") account: guardian session. Creates a restricted account under
	// a non-routable @managed.invalid handle and adds it to the workspace.
	.post(
		"/api/account/managed",
		guardedPost(async (request, session) => {
			let body: Record<string, unknown>;
			try {
				body = (await request.json()) as Record<string, unknown>;
			} catch {
				return new Response("Bad Request", { status: 400 });
			}
			if (
				typeof body.workspaceId !== "string" ||
				typeof body.displayName !== "string" ||
				typeof body.password !== "string"
			) {
				return new Response("Bad Request", { status: 400 });
			}
			try {
				return await createManagedAccount(
					{
						guardianId: session.user.id,
						workspaceId: body.workspaceId,
						displayName: body.displayName,
						password: body.password,
						role: (body.role as never) ?? undefined,
					},
					db,
					auth,
					process.env,
				);
			} catch (error) {
				if (error instanceof ManagedAccountError) {
					return new Response(error.message, { status: error.status });
				}
				throw error;
			}
		}),
	)
	// User lookup for invite-on-assign pickers. Caller session; never returns email
	// addresses (only id/name/image). Mode from DITERO_DISCOVERY.
	.get(
		"/api/users/lookup",
		guardedGet(async (request, session) => {
			const email = new URL(request.url).searchParams.get("email") ?? "";
			return await lookupUsers(email, session.user.id, db);
		}),
	)
	// Notification channels. The config column never syncs, so the settings form
	// reads it here -- masked, never in cleartext (design 6).
	.get(
		"/api/notifications/channels",
		guardedGet(async (_request, session) => ({
			channels: await listChannels(db, session.user.id),
			capabilities: channelCapabilities(),
			interactionsUrls: interactionsUrls(),
		})),
	)
	.post(
		"/api/notifications/channel",
		guardedPost((request, session) =>
			channelWrite(request, (body) => saveChannel(db, session.user.id, body)),
		),
	)
	.post(
		"/api/notifications/channel/delete",
		guardedPost((request, session) =>
			channelWrite(request, (body) => deleteChannel(db, session.user.id, body)),
		),
	)
	.post(
		"/api/notifications/channel/test",
		guardedPost((request, session) =>
			channelWrite(request, (body) => testChannel(db, session.user.id, body)),
		),
	)
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
		// Notification events are collected per mutation and enqueued only after
		// the whole request resolves -- outside the mutator transaction, and only
		// for mutations that actually committed. notifications/events.ts owns both
		// halves and the non-atomicity they accept.
		const events = eventMutateSession(db);
		const result = await handleMutateRequest({
			dbProvider: zdb,
			handler: (transact) =>
				events.run(transact, async (tx, name, args) => {
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
		await events.flush();
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
	// Every replica starts one; the advisory lock elects the leader per tick.
	// Timing is validated here so a bad interval fails at boot, not at 03:00.
	startScheduler(db, pool);
	// Leader-elected like the scan: a periodic table sweep, not a request-driven
	// event.
	startOverdueSweep(db, pool);
	// Leader-elected too, under its own key: Telegram hands an update to
	// whichever poller asks first, so a second one consumes acks away. In
	// webhook mode it registers the listener with each bot instead of polling.
	startTelegramPoller(db, pool);
	// The drain runs on every replica (claims are mediated by SKIP LOCKED).
	// ackBaseUrl is null when no public origin is configured, which disables the
	// ack action rather than minting a link no push client can follow.
	// Validated here so a malformed SMTP setting fails at boot rather than on the
	// first reminder. Absent config is legal: it disables the email channel.
	if (mailConfig(process.env) === null) {
		console.log("ditero: no DITERO_SMTP_HOST, email channel disabled");
	}
	const timing = workerTiming(process.env);
	startWorker(
		db,
		createSendFn({
			database: db,
			allowedPrivateCIDRs: notifyAllowedPrivateCIDRs(
				process.env.DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS,
			),
			deadlineMs: timing.adapterDeadlineMs,
			ackBaseUrl: ackBaseUrl(process.env),
		}),
		process.env,
		timing,
	);
	app.listen(PORT);
	console.log(`ditero api on :${PORT}`);
}

export type App = typeof app;
export { app };
