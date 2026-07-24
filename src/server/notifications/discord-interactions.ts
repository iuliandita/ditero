// Discord's interactions endpoint: the app-mode `Done` button minted by
// adapters/discord.ts comes back here as a MESSAGE_COMPONENT interaction.
//
// This is a transport, not a second ack model -- consume-before-validate,
// single-use and sibling termination all live in redeemAckCapability.
//
// Authenticity is Ed25519 over `timestamp + rawBody` with the app's public key
// (docs.discord.com/developers/interactions/overview: "you must validate the
// request each time you receive an interaction. If the signature fails
// validation, your app should respond with a 401 error code"). Hence
// rejectStatus 401 rather than the seam's default 400 -- Discord disables an
// endpoint that answers anything else to a bad signature.
//
// WHICH public key is the awkward part. Unlike Telegram's deployment-level
// secret token, the key is per-channel config, and nothing in the request is
// parseable before verification -- parse-before-verify is exactly what this seam
// exists to prevent. So verification tries every configured app-mode key
// (deduplicated: one Discord app serving a whole deployment is one key) and
// carries the KEYS that matched into the handler. Once `channel_id` is parsed
// the handler re-queries the rows for that channel alone and keeps only those
// whose key signed these bytes, so an interaction signed by app A cannot act on
// app B's channel. Splitting it that way is also what keeps the row cap
// per-channel rather than deployment-wide.
//
// The key set is user-supplied, not Discord-attested: any authenticated user who
// can save a Discord channel config picks their own `publicKey`, so they can
// make themselves an accepted signer for this public endpoint and reach `handle`
// with a body of their choosing. Contained today because `allowedRecipients` is
// derived from their own rows, so the recipient binding only ever authorises
// capabilities already bound to them -- but anything added to `handle` later
// must not assume the body came from Discord.
//
// Responses are the HTTP response body, not an outbound call: Discord's
// interaction callback for an HTTP-based endpoint IS the reply to this POST, so
// there is no egress here at all.
//
// Outcome model, adapted from telegram-webhook.ts rather than copied. A DECIDED
// outcome (acked, refused, nothing to act on) answers a callback and is final.
// A THROWN redeem also answers 200 -- but with the retry text and the button
// left in place. Telegram answers 500 there so the provider redelivers, which is
// safe because the consume rolls back with the transaction it threw out of.
// Discord has no such redelivery: an interaction is dispatched once and its
// initial response is due within 3 seconds -- missing that deadline invalidates
// the interaction token outright -- so a 500 buys no retry and costs the user the
// generic "This interaction failed" with nothing actionable in it. The
// capability is still live either way, so the recoverable move is to say so and
// leave the button pressable.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Elysia } from "elysia";
import * as tables from "../../db/schema.ts";
import { verifyDiscordSignature } from "../../domain/channel-signature.ts";
import { channelConfigSchema } from "../../domain/notification-channel.ts";
import {
	channelKeyRing,
	decryptChannelConfig,
} from "../../security/channel-config.ts";
import type { Network } from "../client-ip.ts";
import {
	ACK_CUSTOM_ID_PREFIX,
	CONTENT_MAX,
	CUSTOM_ID_MAX,
} from "./adapters/discord.ts";
import { redeemAckCapability } from "./capability.ts";
import {
	dbRateLimit,
	RAW_BODY_ROUTE_CONFIG,
	rawBodyHandler,
} from "./raw-body.ts";

type Database = NodePgDatabase<typeof tables>;

export const DISCORD_INTERACTIONS_PATH =
	"/api/notifications/discord/interactions";
export const DISCORD_SIGNATURE_HEADER = "x-signature-ed25519";
export const DISCORD_TIMESTAMP_HEADER = "x-signature-timestamp";
// Required by Discord for a failed signature check; the seam defaults to 400.
export const DISCORD_REJECT_STATUS = 401;

// docs.discord.com/developers/interactions/receiving-and-responding, Interaction
// Type and Interaction Callback Type. PING/PONG is what validates the endpoint
// URL the operator pastes into the developer portal, so getting it wrong means
// the URL cannot be registered at all.
export const INTERACTION_PING = 1;
export const INTERACTION_MESSAGE_COMPONENT = 3;
export const CALLBACK_PONG = 1;
export const CALLBACK_CHANNEL_MESSAGE = 4;
export const CALLBACK_UPDATE_MESSAGE = 7;
// MessageFlags.EPHEMERAL (1 << 6): visible only to the member who pressed.
const EPHEMERAL = 64;

// reminder_state.acked_via is a channelKindEnum value for channel acks.
const ACK_VIA = "discord";
const ACK_FAIL_TEXT = "This reminder is no longer active.";
// Distinct from ACK_FAIL_TEXT on purpose: the reminder IS still active and the
// button still works, so telling the user it is over would be a lie.
const ACK_RETRY_TEXT = "Couldn't reach the server. Try again.";
const DONE_SUFFIX = "\n\n✓ Done";

// Bounds two different queries. Narrowed by `channelIds` it is telegram-
// update.ts's CANDIDATE_LIMIT exactly: the rows bound to ONE channel, which a
// whole family may share, so a DoS bound rather than a plausible group size.
// Un-narrowed -- the pre-verification key scan, which cannot narrow on anything
// because nothing is parseable yet -- it bounds every app-mode row in the
// deployment, and only the DISTINCT keys survive that scan. Truncation there
// costs an app nothing unless every one of its rows sorts past the cap; it can
// no longer cost an individual user their ack, which is what it did while the
// same capped row set also produced `allowedRecipients`.
export const CANDIDATE_LIMIT = 500;

// The key scan runs before any authentication, so every request that clears the
// IP bucket would otherwise pay a table scan plus one AES-GCM decrypt per
// app-mode row. Cached deployment-wide: keys change only when someone saves a
// channel, and a save going live up to this late is not worth an unauthenticated
// amplification factor of CANDIDATE_LIMIT.
export const KEY_CACHE_TTL_MS = 30_000;

// Every interaction arrives from Discord's own narrow ranges, so the whole
// instance shares one bucket key -- the ack route's 30-burst default would
// throttle a busy afternoon. Identical reasoning to TELEGRAM_RATE_CAPACITY.
export const DISCORD_RATE_CAPACITY = 600;
export const DISCORD_RATE_REFILL_PER_SEC = 20;

export type DiscordAppChannel = {
	userId: string;
	publicKey: string;
	channelId: string;
};

type ParsedInteraction = {
	token: string;
	channelId: string;
	messageContent: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

// Configured app-mode Discord channels, decrypted. Webhook-mode rows carry no
// public key and dispatch no interaction, so they are excluded in SQL.
export async function discordAppChannels(
	database: Database,
	env: NodeJS.ProcessEnv,
	options: { channelIds?: string[]; limit?: number } = {},
): Promise<DiscordAppChannel[]> {
	const rows = await database
		.select({
			userId: tables.notificationChannel.userId,
			config: tables.notificationChannel.config,
		})
		.from(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.kind, "discord"),
				// `mode` and `channelId` are PUBLIC_FIELDS entries, so both are stored
				// in cleartext and can be matched in SQL rather than by decrypting
				// every row in the table. This predicate IS the webhook exclusion:
				// it reads the same `mode` the schema below discriminates on, so a
				// webhook row cannot reach the loop at all. It is also a budget
				// guard -- webhook rows would otherwise spend the limit on rows that
				// can never verify, and an app-mode row pushed past the limit by them
				// is a key never found, which the cap test pins.
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
		.limit(options.limit ?? CANDIDATE_LIMIT);

	const ring = channelKeyRing(env);
	const channels: DiscordAppChannel[] = [];
	for (const row of rows) {
		let config: Record<string, unknown>;
		try {
			config = decryptChannelConfig(
				"discord",
				row.config as Record<string, unknown>,
				ring,
			);
		} catch {
			continue;
		}
		const parsed = channelConfigSchema.discord.safeParse(config);
		if (!parsed.success) continue;
		const channel = parsed.data as
			| { mode: "webhook" }
			| { mode: "app"; publicKey: string; channelId: string };
		// Narrows the discriminated union so the app fields are readable at all.
		// Unreachable for a webhook row while the SQL predicate stands, so no
		// mutation of it alone is observable; it is what keeps this fail-closed if
		// that predicate is ever loosened.
		if (channel.mode !== "app") continue;
		channels.push({
			userId: row.userId,
			publicKey: channel.publicKey,
			channelId: channel.channelId,
		});
	}
	return channels;
}

// Null for anything that is not one of our ack buttons: a non-component
// interaction, a component with no custom_id, or a custom_id another feature
// minted. An interaction with no invoking user is refused here too -- a real
// press always carries one (`member.user` in a guild, `user` in a DM).
function parseComponentAck(
	interaction: Record<string, unknown>,
): ParsedInteraction | null {
	if (interaction.type !== INTERACTION_MESSAGE_COMPONENT) return null;
	const data = asRecord(interaction.data);
	const customId = data?.custom_id;
	if (typeof customId !== "string") return null;
	if (customId.length > CUSTOM_ID_MAX) return null;
	if (!customId.startsWith(ACK_CUSTOM_ID_PREFIX)) return null;
	const token = customId.slice(ACK_CUSTOM_ID_PREFIX.length);
	if (!token) return null;

	const channelId = interaction.channel_id;
	if (typeof channelId !== "string" || !channelId) return null;

	const invoker =
		asRecord(asRecord(interaction.member)?.user) ?? asRecord(interaction.user);
	if (typeof invoker?.id !== "string") return null;

	const content = asRecord(interaction.message)?.content;
	return {
		token,
		channelId,
		messageContent: typeof content === "string" ? content : null,
	};
}

function callback(payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function ephemeral(content: string): Response {
	return callback({
		type: CALLBACK_CHANNEL_MESSAGE,
		data: { content, flags: EPHEMERAL },
	});
}

// UPDATE_MESSAGE edits the message the button was attached to. The empty
// `components` is what removes the button, so a second press is not offered at
// all. Only used on a successful ack: a refusal leaves the shared channel's
// message untouched, or anyone in it could visibly burn someone else's reminder
// by pressing a button that is not theirs.
function ackedUpdate(messageContent: string | null): Response {
	return callback({
		type: CALLBACK_UPDATE_MESSAGE,
		data: {
			components: [],
			...(messageContent === null
				? {}
				: {
						// Trimmed on the CONTENT side, never on the joined string: a
						// message already at the cap would otherwise be edited to end in a
						// sliced-up "✓ Do".
						content: `${messageContent.slice(0, CONTENT_MAX - DONE_SUFFIX.length)}${DONE_SUFFIX}`,
					}),
		},
	});
}

export type DiscordInteractionsOptions = {
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	trustedProxies?: Network[];
	capacity?: number;
	refillPerSec?: number;
	candidateLimit?: number;
	keyCacheTtlMs?: number;
};

export function discordInteractionRoutes(
	database: Database,
	options: DiscordInteractionsOptions = {},
) {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const candidateLimit = options.candidateLimit ?? CANDIDATE_LIMIT;
	const keyCacheTtlMs = options.keyCacheTtlMs ?? KEY_CACHE_TTL_MS;
	// Per-request, keyed on the Request itself: `verify` resolves which
	// configured apps signed the bytes, and `handle` must not re-derive it from
	// a body the framework has by then parsed.
	const signedBy = new WeakMap<Request, Set<string>>();

	let cachedKeys: string[] = [];
	let cachedUntil = 0;
	const publicKeys = async (): Promise<string[]> => {
		const at = now();
		if (at < cachedUntil) return cachedKeys;
		const channels = await discordAppChannels(database, env, {
			limit: candidateLimit,
		});
		cachedKeys = [...new Set(channels.map((channel) => channel.publicKey))];
		cachedUntil = at + keyCacheTtlMs;
		return cachedKeys;
	};

	return new Elysia().post(
		DISCORD_INTERACTIONS_PATH,
		rawBodyHandler({
			expectedMediaType: "application/json",
			rejectStatus: DISCORD_REJECT_STATUS,
			trustedProxies: options.trustedProxies,
			rateLimit: dbRateLimit(database, {
				keyPrefix: "discord:",
				capacity: options.capacity ?? DISCORD_RATE_CAPACITY,
				refillPerSec: options.refillPerSec ?? DISCORD_RATE_REFILL_PER_SEC,
			}),
			verify: async ({ raw, request }) => {
				const signature = request.headers.get(DISCORD_SIGNATURE_HEADER) ?? "";
				const timestamp = request.headers.get(DISCORD_TIMESTAMP_HEADER) ?? "";
				// Subsumed by verifyDiscordSignature, which rejects both empties
				// anyway; kept because it decides before the key scan rather than
				// after it.
				if (!signature || !timestamp) return false;

				// One Ed25519 verification per DISTINCT key: a deployment behind a
				// single Discord app is one check however many users it serves.
				const matched = (await publicKeys()).filter((publicKey) =>
					verifyDiscordSignature(publicKey, signature, timestamp, raw, now()),
				);
				if (matched.length === 0) return false;
				signedBy.set(request, new Set(matched));
				return true;
			},
			handle: async ({ request, body }) => {
				const verifiedKeys = signedBy.get(request) ?? new Set<string>();
				signedBy.delete(request);

				const interaction = asRecord(body.json);
				if (!interaction) return ephemeral(ACK_FAIL_TEXT);
				// Sent when the operator saves the endpoint URL. Registration fails
				// silently for them if this is anything but `{"type": 1}`.
				if (interaction.type === INTERACTION_PING) {
					return callback({ type: CALLBACK_PONG });
				}

				const parsed = parseComponentAck(interaction);
				if (!parsed) return ephemeral(ACK_FAIL_TEXT);

				// Defence in depth (design 5): the capability must belong to someone
				// this channel actually delivers to, AND the channel must belong to
				// the app whose key signed these bytes. Keyed on the CHANNEL rather
				// than the invoking Discord user, for the same reason Telegram keys on
				// the chat: the channel is the binding we minted against and stored,
				// while no Discord user id is recorded anywhere in the config, so a
				// per-user gate would refuse every legitimate press. Residual and
				// accepted, as with a bound Telegram group or a shared ntfy topic:
				// anyone who can see the channel can press the button.
				// Narrowed on the channel now that there is one to narrow on, so the
				// row cap bounds one channel's members rather than the deployment.
				let bound: DiscordAppChannel[];
				try {
					bound = await discordAppChannels(database, env, {
						channelIds: [parsed.channelId],
						limit: candidateLimit,
					});
				} catch (error) {
					console.error("discord: channel lookup failed:", error);
					return ephemeral(ACK_RETRY_TEXT);
				}
				const allowedRecipients = bound
					.filter((channel) => verifiedKeys.has(channel.publicKey))
					.map((channel) => channel.userId);
				if (allowedRecipients.length === 0) return ephemeral(ACK_FAIL_TEXT);

				let redeemed: string | null;
				try {
					redeemed = await redeemAckCapability(
						database,
						parsed.token,
						ACK_VIA,
						now(),
						{ allowedRecipients },
					);
				} catch (error) {
					console.error("discord: redeem failed:", error);
					return ephemeral(ACK_RETRY_TEXT);
				}
				if (redeemed === null) return ephemeral(ACK_FAIL_TEXT);
				return ackedUpdate(parsed.messageContent);
			},
		}),
		RAW_BODY_ROUTE_CONFIG,
	);
}
