// The public ack route. Deliberately unauthenticated and cross-origin (C24):
// the button is pressed from a push client that holds no session, and from
// ntfy's web UI, which is a genuine cross-origin request from ntfy.sh that the
// global CORS policy blocks. Applying guardedPost here would 403 every real ack.
//
// The capability in the URL is the only credential, so the whole security
// posture lives in capability.ts: consume before validate, one uniform
// rejection, a fixed time floor on every reject, and an IP token bucket in
// front of all of it.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import type * as tables from "../../db/schema.ts";
import type { Network } from "../client-ip.ts";
import {
	rateLimitKey,
	resolveClientIP,
	trustedProxyCIDRsFromEnv,
} from "../client-ip.ts";
import {
	ACK_PATH,
	ACK_RATE_CAPACITY,
	ACK_RATE_REFILL_PER_SEC,
	ACK_REJECT_BODY,
	ACK_REJECT_STATUS,
	REJECT_FLOOR_MS,
	redeemAckCapability,
	takeRateToken,
} from "./capability.ts";

type Database = NodePgDatabase<typeof tables>;

export type AckRouteOptions = {
	capacity?: number;
	refillPerSec?: number;
	keyPrefix?: string;
	trustedProxies?: Network[];
};

// Mounted ahead of the app's global header hook (server/index.ts), so these
// replies carry no nosniff/frame headers. Accepted: every response here is a
// constant plaintext string with no markup, script or reflected input.
//
// ntfy's action button cannot follow a redirect chain or read a JSON body; the
// status code is the whole protocol. `*` because the caller is an arbitrary
// third-party notification UI and the route carries no cookies or credentials.
const ACK_CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "POST, OPTIONS",
	"access-control-max-age": "600",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ackRoutes(database: Database, options: AckRouteOptions = {}) {
	const capacity = options.capacity ?? ACK_RATE_CAPACITY;
	const refillPerSec = options.refillPerSec ?? ACK_RATE_REFILL_PER_SEC;
	const keyPrefix = options.keyPrefix ?? "ack:";
	const trustedProxies =
		options.trustedProxies ??
		trustedProxyCIDRsFromEnv(process.env.DITERO_TRUSTED_PROXIES);

	return new Elysia()
		.options(
			`${ACK_PATH}/:token`,
			() =>
				new Response(null, {
					status: 204,
					headers: ACK_CORS,
				}),
		)
		.post(`${ACK_PATH}/:token`, async ({ params, request, server }) => {
			const started = Date.now();
			// Every rejection costs at least REJECT_FLOOR_MS regardless of which
			// check failed (C26).
			const reject = async () => {
				// Rounded UP to the next whole floor, not clamped at one: padding
				// can only ever extend, so a slow reject path (consume, two reads,
				// a rollback, under contention) would otherwise overshoot the floor
				// and become distinguishable from a fast one again.
				const elapsed = Date.now() - started;
				const target =
					(Math.floor(elapsed / REJECT_FLOOR_MS) + 1) * REJECT_FLOOR_MS;
				await sleep(target - elapsed);
				return new Response(ACK_REJECT_BODY, {
					status: ACK_REJECT_STATUS,
					headers: ACK_CORS,
				});
			};

			// Keyed on the resolved client address: the in-memory pattern is
			// single-process and this pipeline is multi-replica by definition.
			const peerAddress = server?.requestIP(request)?.address ?? "127.0.0.1";
			const clientIP = rateLimitKey(
				resolveClientIP({
					peerAddress,
					forwardedFor: request.headers.get("x-forwarded-for"),
					trustedProxies,
				}),
			);
			const allowed = await takeRateToken(
				database,
				`${keyPrefix}${clientIP}`,
				capacity,
				refillPerSec,
			);
			// Distinct from the token rejection on purpose: it is scoped to the
			// address, decided before the token is read, and so reveals nothing
			// about whether any token was real.
			if (!allowed) {
				return new Response("Too Many Requests", {
					status: 429,
					headers: ACK_CORS,
				});
			}

			let ok: boolean;
			try {
				ok = await redeemAckCapability(database, params.token, "capability");
			} catch (error) {
				// Logged, not surfaced: a 500 here would tell a prober that this
				// token reached the completion path, which the uniform rejection
				// exists to hide.
				console.error("ack: redeem failed:", error);
				return await reject();
			}
			if (!ok) return await reject();
			return new Response("Done.", { status: 200, headers: ACK_CORS });
		});
}
