// Telegram's webhook transport: the provider POSTs the callback_query here.
// Handling it is telegram-update.ts, shared verbatim with the poll transport --
// this file owns authenticity, rate limiting and the HTTP retry protocol, and
// nothing else.
//
// Authenticity is the secret token Telegram echoes on every webhook delivery
// (setWebhook's `secret_token`), compared constant-time. It is DEPLOYMENT-level
// (DITERO_TELEGRAM_WEBHOOK_SECRET), not per user: setWebhook is per bot and
// every bot posts to this one URL, so a per-channel secret would have nothing
// to select it by before the body is parsed -- which
// is exactly the parse-before-verify order this seam exists to prevent. Unset
// means the listener authenticates nothing, so it rejects everything.
//
// Status codes here are a retry protocol with Telegram, not an oracle: only a
// holder of DITERO_TELEGRAM_WEBHOOK_SECRET reaches any branch past the secret
// check (raw-body.ts states the same reasoning for omitting REJECT_FLOOR_MS),
// so there is no unauthenticated observer to hide outcomes from.
//
// A DECIDED outcome answers 200, redeemed or refused alike: the capability is
// burnt either way and a redelivery would only re-run a decision already made.
// A THROWN redeem answers 500 so Telegram redelivers, which is safe precisely
// because it failed: redeemAckCapability runs the consume inside the
// transaction it rethrows out of, so the burn rolls back with everything else
// and the token is still live. Answering 200 there would drop the user's tap
// and tell them the reminder was over while it was still escalating.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import type * as tables from "../../db/schema.ts";
import { verifyTelegramSecret } from "../../domain/channel-signature.ts";
import type { safeFetch as SafeFetch } from "../../security/safe-http.ts";
import { safeFetch } from "../../security/safe-http.ts";
import type { Network } from "../client-ip.ts";
import {
	dbRateLimit,
	RAW_BODY_ROUTE_CONFIG,
	rawBodyHandler,
} from "./raw-body.ts";
import { handleTelegramUpdate } from "./telegram-update.ts";

type Database = NodePgDatabase<typeof tables>;

export const TELEGRAM_WEBHOOK_PATH = "/api/notifications/telegram/webhook";
export const TELEGRAM_SECRET_HEADER = "x-telegram-bot-api-secret-token";

// This bucket keys on the client address, and every delivery arrives from
// Telegram's own narrow ranges -- so the whole instance shares one key, for
// every update the bot receives, ordinary group chatter included. The ack
// route's 30 burst / 0.5-per-second defaults would throttle the deployment on
// a busy afternoon, and a 429 is a delivery failure to Telegram, which answers
// by backing the entire webhook off: overload would feed straight back into ack
// latency. Keyed on the address rather than chatId because the limiter runs
// before the body is read -- that ordering is what stops a flood from making us
// buffer -- so this stays a coarse body-read guard, sized well above any real
// bot's update rate.
export const TELEGRAM_RATE_CAPACITY = 600;
export const TELEGRAM_RATE_REFILL_PER_SEC = 20;

export type TelegramWebhookOptions = {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof SafeFetch;
	trustedProxies?: Network[];
	capacity?: number;
	refillPerSec?: number;
};

export function telegramWebhookRoutes(
	database: Database,
	options: TelegramWebhookOptions = {},
) {
	const env = options.env ?? process.env;
	const secret = env.DITERO_TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
	const send = options.fetch ?? safeFetch;

	return new Elysia().post(
		TELEGRAM_WEBHOOK_PATH,
		rawBodyHandler({
			expectedMediaType: "application/json",
			trustedProxies: options.trustedProxies,
			rateLimit: dbRateLimit(database, {
				keyPrefix: "telegram:",
				capacity: options.capacity,
				refillPerSec: options.refillPerSec,
			}),
			// verifyTelegramSecret is false for an empty expected secret, so an
			// unconfigured listener rejects every delivery rather than accepting
			// every one of them.
			verify: ({ request }) =>
				verifyTelegramSecret(
					secret,
					request.headers.get(TELEGRAM_SECRET_HEADER) ?? "",
				),
			handle: async ({ body }) => {
				// A malformed or uninteresting update is accepted and dropped: it is
				// authentic (it carried the secret) and redelivering it would change
				// nothing.
				const outcome = await handleTelegramUpdate(
					database,
					body.json,
					send,
					env,
				);
				return new Response(null, {
					status: outcome === "failed" ? 500 : 200,
				});
			},
		}),
		RAW_BODY_ROUTE_CONFIG,
	);
}
