import { Elysia } from "elysia";
import { channelKeyRing } from "../../security/channel-config.ts";
import { readJsonObject } from "../native-auth/contracts.ts";
import { authenticateNative } from "../native-auth/session.ts";
import { pushConfiguration } from "./contracts.ts";
import {
	activateOffer,
	allocateOffer,
	RelayInstanceError,
	updateReceipt,
} from "./relay-contracts.ts";
import { NativeRelayStore } from "./relay-store.ts";
import type { NativePushDependencies } from "./routes.ts";
import { PushAuthorityError } from "./store.ts";
export function nativeRelayRoutes(deps: NativePushDependencies): Elysia {
	const trust = (deps.configuration ?? pushConfiguration())["fcm-relay"];
	const ring = deps.ring === undefined ? channelKeyRing() : deps.ring;
	const store =
		trust && ring ? new NativeRelayStore(deps.pool, ring, trust) : null;
	const peers = new WeakMap<Request, string>();
	const app = new Elysia().onRequest(({ request, server }) => {
		const address = server?.requestIP(request)?.address;
		if (address) peers.set(request, address);
	});
	const post =
		(kind: "offer" | "activate" | "update" | "cancel") =>
		async ({ request }: { request: Request }) => {
			const reply = (body: unknown, status = 200) =>
				Response.json(body, {
					status,
					headers: { "cache-control": "no-store" },
				});
			if (request.headers.has("cookie") || request.headers.has("origin"))
				return reply({ code: "credentials-not-allowed" }, 400);
			try {
				if (!(await deps.rateLimit(request, peers.get(request))))
					return reply({ code: "rate-limited" }, 429);
				const owner = await authenticateNative(deps.pool, request.headers);
				if (!owner) return reply({ code: "unauthorized" }, 401);
				if (!store) return reply({ code: "provider-unavailable" }, 409);
				const body = await readJsonObject(request, 16384);
				if (!body.ok) return reply({ code: "invalid-body" }, body.status);
				if (kind === "offer") {
					const input = allocateOffer.safeParse(body.value);
					return input.success
						? reply(await store.offer(owner, input.data))
						: reply({ code: "invalid-body" }, 400);
				}
				if (kind === "activate") {
					const input = activateOffer.safeParse(body.value);
					return input.success
						? reply(
								await store.activate(
									owner,
									input.data.offerId,
									input.data.receipt,
								),
							)
						: reply({ code: "invalid-body" }, 400);
				}
				if (kind === "update") {
					const input = updateReceipt.safeParse(body.value);
					return input.success
						? reply(
								await store.update(
									owner,
									input.data.registrationId,
									input.data.expectedGeneration,
									input.data.receipt,
								),
							)
						: reply({ code: "invalid-body" }, 400);
				}
				const input = activateOffer
					.pick({ offerId: true })
					.safeParse(body.value);
				return input.success
					? reply(await store.cancel(owner, input.data.offerId))
					: reply({ code: "invalid-body" }, 400);
			} catch (error) {
				if (error instanceof PushAuthorityError)
					return reply({ code: "unauthorized" }, 401);
				if (error instanceof RelayInstanceError)
					return reply({ code: error.code }, error.status);
				console.error("native relay request failed");
				return reply({ code: "native-push-failed" }, 500);
			}
		};
	for (const kind of ["offer", "activate", "update", "cancel"] as const)
		app.post(`/api/native/push/relay/${kind}`, post(kind));
	return app;
}
