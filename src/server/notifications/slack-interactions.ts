// Slack's interactivity endpoint: the app-mode `Done` button minted by
// adapters/slack.ts comes back here as a block_actions payload.
//
// This is a transport, not a second ack model -- consume-before-validate,
// single-use and sibling termination all live in redeemAckCapability.
//
// Authenticity is `v0=` + hex HMAC-SHA256 over `v0:{timestamp}:{rawBody}` with
// the app's signing secret, inside a 300s window both directions
// (docs.slack.dev/authentication/verifying-requests-from-slack). Slack signs the
// FORM OCTETS, not the JSON inside the `payload` field, so verification runs on
// the raw bytes and the seam lifts `payload` only afterwards.
//
// WHICH signing secret is the awkward part, exactly as with Discord's public
// key: it is per-channel config, and nothing in the request is parseable before
// verification. Two steps, deliberately split:
//
//   1. `verify` needs only the DISTINCT signing secrets, so that is all it
//      gathers -- one HMAC per secret, not per row, and no row list.
//   2. `handle` knows `channel.id` from the parsed payload, so it re-queries
//      narrowly on that channel and keeps the rows whose secret signed THESE
//      bytes.
//
// No SIGNER SET is carried between the two: `handle` receives the same raw
// octets and re-derives it. That is deliberate -- carrying the matched secrets
// would be a fail-open surface asserted by nobody, and the re-derivation makes
// "signed by the app that owns this channel" a property of the row filter
// rather than of a value smuggled across callbacks. When the seam grows a typed
// verify->handle channel, the only change is that `signersForChannel` takes the
// already-matched secret set instead of a predicate.
//
// The one thing that IS carried is the instant `verify` read the clock at, and
// only because re-deriving it cannot fail open: a request that verifies at
// T+299.9s into the 300s replay window would otherwise fail re-derivation in
// `handle` and tell a legitimate presser their reminder is over. Anchoring both
// checks at the earlier instant can only accept what `verify` already accepted,
// and a missing entry falls back to a fresh reading, so nothing is bypassed.
//
// THE SIGNER SET IS USER-SUPPLIED, not Slack-attested: any authenticated user
// who can save a Slack channel config picks their own `signingSecret` and
// `channelId`, so they can make themselves an accepted signer for this public
// endpoint and reach `handle` with a body of their choosing. Contained today
// because `allowedRecipients` is derived from their own rows, so the recipient
// binding only ever authorises capabilities already bound to them, and because
// `response_url` -- the one field of that body that becomes an outbound target
// -- is pinned to host AND path. Anything added to `handle` later must not
// assume the body came from Slack.
//
// The row set is NEVER capped on the correctness path. Discord's route caps a
// deployment-wide candidate list at 500 ordered by userId, which silently makes
// every channel past the cap permanently unackable. Here the uncapped scan
// yields secrets only, and the capped query is narrowed to one channel first --
// the same per-chat bound telegram-update.ts actually has.
//
// AMPLIFICATION, stated rather than hidden: the pre-verification step decrypts
// one config per app-mode Slack row. There is no cleartext discriminator for a
// signing secret, so nothing narrower is available before the payload is
// parsed. Two bounds instead: the IP token bucket ahead of it, and SECRET_CACHE_
// TTL_MS, so the scan runs at most once per window rather than once per request
// -- this route carries strictly more pre-auth traffic than Discord's, because
// every webhook-mode link button in the deployment starts delivering here the
// moment the Request URL is registered (see below).
//
// THE UNRECOGNISED-ACTION HAZARD, and the reason this file cannot simply mirror
// Discord. Slack's button docs: "If you're using `url`, you'll still receive an
// interaction payload and will need to send an acknowledgement response."
// Webhook-mode link buttons send no interaction today only because no Request
// URL is registered; registering this route makes every one of them deliver a
// payload here. An unacknowledged payload paints a red "!" on a button that
// worked the day before, so an action_id this app does not mint is answered
// with a clean 200 and changes nothing. Discord's hazard runs the other way (a
// silently dropped component), and copying its refusal would break every
// webhook-mode channel the moment this route exists.
//
// Thrown redeem answers 200 as well, and for a Slack-specific reason. Slack
// requires HTTP 200 within 3 seconds and does not DOCUMENT redelivery of an
// interaction payload -- retries are documented for the Events API only, and
// the absence of a promise is not a promise of absence. Either way a 500 buys
// no guaranteed retry and costs the user Slack's generic connectivity error
// with nothing actionable in it, while a redelivery would simply be re-refused
// against a capability that is still live (the consume rolls back with the
// transaction it threw out of). So the recoverable move is to say so
// ephemerally and leave the button pressable.
//
// THE UNSIGNED-INTERACTION HAZARD, the one branch with no graceful answer: an
// interaction that no configured secret signs is rejected by the seam with a
// 400 and the presser sees the red "!". That is reachable without an attacker
// -- the app-mode row was deleted, the signing secret was rotated, or the IP
// bucket returned 429 -- and it is correct (an unverifiable body must not reach
// `handle`), but it is not invisible to the user.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import * as tables from "../../db/schema.ts";
import { verifySlackSignature } from "../../domain/channel-signature.ts";
import { channelConfigSchema } from "../../domain/notification-channel.ts";
import {
	channelKeyRing,
	decryptChannelConfig,
} from "../../security/channel-config.ts";
import type { safeFetch as SafeFetch } from "../../security/safe-http.ts";
import { safeFetch } from "../../security/safe-http.ts";
import type { Network } from "../client-ip.ts";
import {
	ACK_ACTION_ID,
	ACK_VALUE_PREFIX,
	ACTION_VALUE_MAX,
	SECTION_TEXT_MAX,
} from "./adapters/slack.ts";
import { redeemAckCapability } from "./capability.ts";
import {
	dbRateLimit,
	RAW_BODY_ROUTE_CONFIG,
	rawBodyHandler,
} from "./raw-body.ts";

type Database = NodePgDatabase<typeof tables>;

export const SLACK_INTERACTIONS_PATH = "/api/notifications/slack/interactions";
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";

// reminder_state.acked_via is a channelKindEnum value for channel acks.
const ACK_VIA = "slack";
const ACK_FAIL_TEXT = "This reminder is no longer active.";
// Distinct from ACK_FAIL_TEXT on purpose: the reminder IS still active and the
// button still works, so telling the user it is over would be a lie.
const ACK_RETRY_TEXT = "Couldn't reach the server. Try again.";
const DONE_SUFFIX = "\n\n✓ Done";

// What is rebuilt here is a top-level message `text`, whose documented cap is
// 40,000 (4,000 recommended) -- NOT a section block, which is what
// SECTION_TEXT_MAX names. Borrowed anyway rather than given its own number: the
// adapter clamps every `text` it sends to that same 3,000, so matching it is
// what makes "unchanged length in, unchanged length out" true, and a larger
// bound here could only ever apply to text this app did not write.
const REPLACEMENT_TEXT_MAX = SECTION_TEXT_MAX;

// response_url is Slack's own capability URL for the pressed message, valid 5
// times within 30 minutes. Pinned even though the bytes were
// signature-verified, because the signer set is user-supplied (see the header):
// this is the one attacker-shaped field that becomes an outbound target.
//
// HOST AND PATH BOTH, and the path is the load-bearing half. block_actions
// mints `https://hooks.slack.com/actions/{app}/{id}/{token}`
// (docs.slack.dev/reference/interaction-payloads/block_actions-payload,
// checked 2026-07-23). `hooks.slack.com/services/...` is an INCOMING WEBHOOK on
// the same host, and the `{ text }` body posted below is exactly what such a
// webhook publishes -- so a host-only pin would let anyone who can save a Slack
// channel post chosen text into any workspace whose webhook URL they know, from
// our egress IP.
const RESPONSE_URL_HOST = "hooks.slack.com";
const RESPONSE_URL_PATH_PREFIX = "/actions/";
const RESPONSE_DEADLINE_MS = 5_000;
const RESPONSE_MAX_BYTES = 16 * 1_024;

// PER-CHANNEL, like telegram-update.ts's: one shared channel a whole family is
// bound to is N rows, so this bounds the decrypt for a single channel rather
// than truncating the deployment.
const CANDIDATE_LIMIT = 500;

// The secret scan runs before any authentication and cannot narrow on anything,
// so every request that clears the IP bucket would otherwise pay a table scan
// plus one AES-GCM decrypt and one Zod parse per app-mode row. Cached
// deployment-wide: secrets change only when someone saves a channel, and a save
// going live up to this late is not worth an unauthenticated amplification
// factor of every app-mode row in the deployment.
//
// Only the SECRET SET is cached, never the rows. A stale secret can at most get
// a request into `handle`, where `signersForChannel` re-queries fresh and the
// authoritative per-channel filter runs against current rows.
const SECRET_CACHE_TTL_MS = 30_000;

// Every interaction arrives from Slack's own ranges, but the bucket key is the
// client IP like every other route's (raw-body.ts resolveClientIP), so this
// capacity is what keeps one Slack egress address from throttling a busy
// afternoon. Identical reasoning to TELEGRAM_RATE_CAPACITY.
const SLACK_RATE_CAPACITY = 600;
const SLACK_RATE_REFILL_PER_SEC = 20;

type SlackAppChannel = {
	userId: string;
	signingSecret: string;
	channelId: string;
};

type ParsedAction = {
	token: string;
	channelId: string;
	responseUrl: string | null;
	messageText: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// Configured app-mode Slack channels, decrypted. Webhook-mode rows carry no
// signing secret and mint no interactive button, so they are excluded in SQL.
// `limit` is optional on purpose: the unnarrowed call must not truncate.
async function appModeChannels(
	database: Database,
	env: NodeJS.ProcessEnv,
	options: { channelIds?: string[]; limit?: number } = {},
): Promise<SlackAppChannel[]> {
	const query = database
		.select({
			userId: tables.notificationChannel.userId,
			config: tables.notificationChannel.config,
		})
		.from(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.kind, "slack"),
				// `mode` and `channelId` are PUBLIC_FIELDS entries, so both are stored
				// in cleartext and can be matched in SQL rather than by decrypting
				// every row in the table.
				sql`${tables.notificationChannel.config}->>'mode' = 'app'`,
				options.channelIds
					? inArray(
							sql`${tables.notificationChannel.config}->>'channelId'`,
							options.channelIds,
						)
					: undefined,
			),
		)
		.orderBy(tables.notificationChannel.userId)
		.$dynamic();
	const rows = await (options.limit === undefined
		? query
		: query.limit(options.limit));

	const ring = channelKeyRing(env);
	const channels: SlackAppChannel[] = [];
	for (const row of rows) {
		let config: Record<string, unknown>;
		try {
			config = decryptChannelConfig(
				"slack",
				row.config as Record<string, unknown>,
				ring,
			);
		} catch {
			continue;
		}
		const parsed = channelConfigSchema.slack.safeParse(config);
		if (!parsed.success) continue;
		const channel = parsed.data as
			| { mode: "webhook" }
			| { mode: "app"; signingSecret: string; channelId: string };
		if (channel.mode !== "app") continue;
		channels.push({
			userId: row.userId,
			signingSecret: channel.signingSecret,
			channelId: channel.channelId,
		});
	}
	return channels;
}

// Everything the pre-verification step is allowed to know: one HMAC per
// DISTINCT secret, never per row, and no row list leaves this function.
async function appModeSigningSecrets(
	database: Database,
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	const channels = await appModeChannels(database, env);
	return [...new Set(channels.map((channel) => channel.signingSecret))];
}

// The rows for ONE channel whose secret actually signed the request. Narrow by
// construction: `channelId` is a PUBLIC_FIELDS entry, so it can be matched in
// SQL rather than by decrypting every row, and no deployment-wide list is ever
// built. (Matched, not indexed: `notification_channel` carries only its primary
// key and unique(user_id, kind), so both queries seq-scan. The split is about
// what leaves each query, not about an index that does not exist.)
// An empty result is the fail-closed case and the only one: `signed` is applied
// as a filter, so a channel nobody signed for yields no recipients.
async function signersForChannel(
	database: Database,
	env: NodeJS.ProcessEnv,
	channelId: string,
	limit: number,
	signed: (signingSecret: string) => boolean,
): Promise<SlackAppChannel[]> {
	const channels = await appModeChannels(database, env, {
		channelIds: [channelId],
		limit,
	});
	const decided = new Map<string, boolean>();
	return channels.filter((channel) => {
		const cached = decided.get(channel.signingSecret);
		if (cached !== undefined) return cached;
		const ok = signed(channel.signingSecret);
		decided.set(channel.signingSecret, ok);
		return ok;
	});
}

// Null for anything that is not one of OUR ack buttons -- a non-block_actions
// payload, an action_id another feature (or Slack itself, for a webhook-mode
// link button) minted, a value with no capability in it. Every one of those is
// answered 200 and dropped; see the header.
function parseAckAction(payload: Record<string, unknown>):
	| {
			recognised: false;
	  }
	| { recognised: true; action: ParsedAction } {
	const unrecognised = { recognised: false } as const;
	if (payload.type !== "block_actions") return unrecognised;
	const actions = payload.actions;
	if (!Array.isArray(actions)) return unrecognised;
	const action = actions
		.map(asRecord)
		.find((entry) => entry?.action_id === ACK_ACTION_ID);
	if (!action) return unrecognised;

	const value = action.value;
	if (typeof value !== "string") return unrecognised;
	if (value.length > ACTION_VALUE_MAX) return unrecognised;
	if (!value.startsWith(ACK_VALUE_PREFIX)) return unrecognised;
	const token = value.slice(ACK_VALUE_PREFIX.length);
	if (!token) return unrecognised;

	const channelId = asRecord(payload.channel)?.id;
	if (typeof channelId !== "string" || !channelId) return unrecognised;
	// A real press always carries one; its absence means this is not a user
	// action at all.
	if (typeof asRecord(payload.user)?.id !== "string") return unrecognised;

	const responseUrl = payload.response_url;
	const messageText = asRecord(payload.message)?.text;
	return {
		recognised: true,
		action: {
			token,
			channelId,
			responseUrl: typeof responseUrl === "string" ? responseUrl : null,
			messageText: typeof messageText === "string" ? messageText : null,
		},
	};
}

// Slack mints this URL, but it still becomes an outbound target, so it is
// checked before it is used rather than trusted for having been signed.
function usableResponseUrl(value: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		// `===` on the host, never endsWith: `evilhooks.slack.com` is a different
		// registration. The path prefix is what excludes `/services/` incoming
		// webhooks on the real host; see RESPONSE_URL_PATH_PREFIX.
		return url.protocol === "https:" &&
			url.hostname === RESPONSE_URL_HOST &&
			url.pathname.startsWith(RESPONSE_URL_PATH_PREFIX)
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

async function postResponse(
	send: typeof SafeFetch,
	responseUrl: string | null,
	body: Record<string, unknown>,
): Promise<void> {
	const url = usableResponseUrl(responseUrl);
	if (!url) return;
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(), RESPONSE_DEADLINE_MS);
	try {
		await send(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: deadline.signal,
			maxResponseBytes: RESPONSE_MAX_BYTES,
		});
	} catch {
		// Nothing interpolated: response_url is itself a bearer capability for the
		// message, and this line is the one an operator greps.
		console.warn("slack: response_url post failed");
	} finally {
		clearTimeout(timer);
	}
}

// Only ever the presser sees this, and the shared channel's message is left
// alone: a refusal that rewrote the message would let anyone in the channel
// visibly burn someone else's reminder by pressing a button that is not theirs.
function ephemeral(send: typeof SafeFetch, action: ParsedAction, text: string) {
	return postResponse(send, action.responseUrl, {
		response_type: "ephemeral",
		replace_original: false,
		text,
	});
}

// `replace_original` with text and no blocks is what removes the button: the
// replacement message has no actions block at all, so a second press is not
// offered.
function ackedUpdate(send: typeof SafeFetch, action: ParsedAction) {
	const text = action.messageText ?? "Reminder";
	return postResponse(send, action.responseUrl, {
		replace_original: true,
		// Trimmed on the CONTENT side, never on the joined string: the adapter
		// already caps what it sends at REPLACEMENT_TEXT_MAX, so a title at the cap
		// would otherwise be replaced by a message ending in a sliced-up "✓ Do" --
		// or, at exactly the cap, by an unchanged message after a successful ack.
		text: `${text.slice(0, REPLACEMENT_TEXT_MAX - DONE_SUFFIX.length)}${DONE_SUFFIX}`,
	});
}

export type SlackInteractionsOptions = {
	env?: NodeJS.ProcessEnv;
	fetch?: typeof SafeFetch;
	now?: () => number;
	trustedProxies?: Network[];
	capacity?: number;
	refillPerSec?: number;
	candidateLimit?: number;
	secretCacheTtlMs?: number;
};

export function slackInteractionRoutes(
	database: Database,
	options: SlackInteractionsOptions = {},
) {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const send = options.fetch ?? safeFetch;
	const candidateLimit = options.candidateLimit ?? CANDIDATE_LIMIT;
	const secretCacheTtlMs = options.secretCacheTtlMs ?? SECRET_CACHE_TTL_MS;
	// Slack requires a 200 for every interaction it delivers, ours or not.
	const accepted = () => new Response(null, { status: 200 });
	// The verification instant, and nothing else, carried from `verify` to
	// `handle`; see the header for why this one is safe to carry and the signer
	// set is not.
	const verifiedAt = new WeakMap<Request, number>();
	// The one place a signature is checked, used by both callbacks over the same
	// raw octets. Curried so `handle` can re-derive the signer set without a
	// side channel; see the header.
	const signatureCheck =
		(request: Request, raw: Uint8Array, at: number) =>
		(secret: string): boolean =>
			verifySlackSignature(
				secret,
				request.headers.get(SLACK_SIGNATURE_HEADER) ?? "",
				request.headers.get(SLACK_TIMESTAMP_HEADER) ?? "",
				raw,
				at,
			);

	let cachedSecrets: string[] = [];
	let cachedUntil = 0;
	const signingSecrets = async (at: number): Promise<string[]> => {
		if (at < cachedUntil) return cachedSecrets;
		cachedSecrets = await appModeSigningSecrets(database, env);
		cachedUntil = at + secretCacheTtlMs;
		return cachedSecrets;
	};

	return new Elysia().post(
		SLACK_INTERACTIONS_PATH,
		rawBodyHandler({
			expectedMediaType: "application/x-www-form-urlencoded",
			trustedProxies: options.trustedProxies,
			rateLimit: dbRateLimit(database, {
				keyPrefix: "slack:",
				capacity: options.capacity ?? SLACK_RATE_CAPACITY,
				refillPerSec: options.refillPerSec ?? SLACK_RATE_REFILL_PER_SEC,
			}),
			verify: async ({ raw, request }) => {
				if (
					!request.headers.get(SLACK_SIGNATURE_HEADER) ||
					!request.headers.get(SLACK_TIMESTAMP_HEADER)
				) {
					return false;
				}
				const at = now();
				const signed = signatureCheck(request, raw, at);
				// Secrets only, and `.some` short-circuits: a deployment behind a
				// single Slack app is one HMAC however many users it serves.
				const ok = (await signingSecrets(at)).some(signed);
				if (ok) verifiedAt.set(request, at);
				return ok;
			},
			handle: async ({ request, raw, body }) => {
				const at = verifiedAt.get(request) ?? now();
				verifiedAt.delete(request);
				const payload = asRecord(body.json);
				if (!payload) return accepted();
				const parsed = parseAckAction(payload);
				// The hazard in the header: not ours, so acknowledged and dropped.
				if (!parsed.recognised) return accepted();
				const action = parsed.action;

				// Defence in depth (design 5): the capability must belong to someone
				// this channel actually delivers to, AND the channel must belong to
				// the app whose secret signed these bytes. Keyed on the CHANNEL rather
				// than the pressing Slack user, for the same reason Telegram keys on
				// the chat: the channel is the binding we minted against and stored,
				// while no Slack user id is recorded anywhere in the config, so a
				// per-user gate would refuse every legitimate press. Residual and
				// accepted, as with a bound Telegram group or a shared ntfy topic:
				// anyone who can see the channel can press the button.
				const signers = await signersForChannel(
					database,
					env,
					action.channelId,
					candidateLimit,
					signatureCheck(request, raw, at),
				);
				const allowedRecipients = signers.map((channel) => channel.userId);
				if (allowedRecipients.length === 0) {
					await ephemeral(send, action, ACK_FAIL_TEXT);
					return accepted();
				}

				let redeemed: string | null;
				try {
					redeemed = await redeemAckCapability(
						database,
						action.token,
						ACK_VIA,
						now(),
						{ allowedRecipients },
					);
				} catch (error) {
					console.error("slack: redeem failed:", error);
					await ephemeral(send, action, ACK_RETRY_TEXT);
					return accepted();
				}
				if (redeemed === null) {
					await ephemeral(send, action, ACK_FAIL_TEXT);
					return accepted();
				}
				await ackedUpdate(send, action);
				return accepted();
			},
		}),
		RAW_BODY_ROUTE_CONFIG,
	);
}
