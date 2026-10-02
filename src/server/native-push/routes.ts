import { Elysia } from "elysia";
import type { Pool } from "pg";
import { channelKeyRing } from "../../security/channel-config.ts";
import type { FieldKeyRing } from "../../security/field-encryption.ts";
import { OutboundPolicyError } from "../../security/safe-http.ts";
import { readJsonObject } from "../native-auth/contracts.ts";
import {
	authenticateNative,
	type NativeSession,
} from "../native-auth/session.ts";
import {
	type PushConfiguration,
	parseRegistration,
	pushConfiguration,
	validatePushEndpoint,
} from "./contracts.ts";
import { NativePushStore, PushAuthorityError } from "./store.ts";
export type NativePushDependencies = {
	pool: Pool;
	rateLimit: (request: Request, peerAddress?: string) => Promise<boolean>;
	configuration?: PushConfiguration;
	ring?: FieldKeyRing | null;
	validateEndpoint?: (endpoint: string) => Promise<void>;
};
function reply(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: { "cache-control": "no-store" },
	});
}
export function nativePushRoutes(deps: NativePushDependencies): Elysia {
	const configuration = deps.configuration ?? pushConfiguration();
	const ring = deps.ring === undefined ? channelKeyRing() : deps.ring;
	const store = ring ? new NativePushStore(deps.pool, ring) : null;
	const peers = new WeakMap<Request, string>();
	const guarded =
		(
			handler: (request: Request, session: NativeSession) => Promise<Response>,
		) =>
		async ({ request }: { request: Request }) => {
			if (request.headers.has("cookie") || request.headers.has("origin"))
				return reply({ code: "credentials-not-allowed" }, 400);
			try {
				if (!(await deps.rateLimit(request, peers.get(request))))
					return reply({ code: "rate-limited" }, 429);
				const session = await authenticateNative(deps.pool, request.headers);
				if (!session) return reply({ code: "unauthorized" }, 401);
				return await handler(request, session);
			} catch (error) {
				if (error instanceof PushAuthorityError)
					return reply({ code: "unauthorized" }, 401);
				if (error instanceof OutboundPolicyError)
					return reply({ code: "invalid-endpoint" }, 400);
				console.error("native push request failed");
				return reply({ code: "native-push-failed" }, 500);
			}
		};
	const app = new Elysia();
	app
		.onRequest(({ request, server }) => {
			const peer = server?.requestIP(request)?.address;
			if (peer) peers.set(request, peer);
		})
		.onError(() => reply({ code: "native-push-failed" }, 500))
		.get(
			"/api/native/push/config",
			guarded(async () =>
				reply({
					deliveryReady: false,
					providers: {
						unifiedpush: !!store && !!configuration.unifiedpush,
						fcm: !!store && !!configuration.fcm,
					},
					vapidPublicKey: store
						? (configuration.unifiedpush?.publicKey ?? null)
						: null,
					fcmProjectId: store ? (configuration.fcm?.projectId ?? null) : null,
				}),
			),
		)
		.post(
			"/api/native/push/register",
			guarded(async (request, session) => {
				const body = await readJsonObject(request, 8192);
				if (!body.ok) return reply({ code: "invalid-body" }, body.status);
				const input = parseRegistration(body.value);
				if (!input) return reply({ code: "invalid-body" }, 400);
				if (!store || !configuration[input.provider])
					return reply({ code: "provider-unavailable" }, 409);
				if (input.provider === "unifiedpush")
					await (deps.validateEndpoint ?? validatePushEndpoint)(input.endpoint);
				return reply(await store.register(session, input));
			}),
		)
		.post(
			"/api/native/push/unregister",
			guarded(async (request, session) => {
				const body = await readJsonObject(request, 8192);
				if (!body.ok) return reply({ code: "invalid-body" }, body.status);
				if (Object.keys(body.value).length)
					return reply({ code: "invalid-body" }, 400);
				// Unregister works after provider disablement; credentials remain encrypted.
				if (!store) return reply({ code: "provider-unavailable" }, 409);
				await store.unregister(session);
				return reply({ unregistered: true });
			}),
		);
	return app;
}
