// Channel CRUD + test-send. The config column never syncs and never leaves the
// server in cleartext: reads hand back maskChannelConfig output, writes restore
// the MASKED placeholder from the caller's own stored row, and the secret half
// is enveloped at rest (security/channel-config.ts).
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { isMailConfigured } from "../../config/mail.ts";
import { notifyAllowedPrivateCIDRs } from "../../config/notify-egress.ts";
import { type TelegramMode, telegramMode } from "../../config/telegram.ts";
import { workerTiming } from "../../config/worker.ts";
import * as tables from "../../db/schema.ts";
import type { ChannelKind } from "../../domain/notification-channel.ts";
import {
	channelConfigSchema,
	maskChannelConfig,
	restoreChannelConfig,
} from "../../domain/notification-channel.ts";
import {
	channelKeyRing,
	decryptChannelConfig,
	encryptChannelConfig,
} from "../../security/channel-config.ts";
import type { safeFetch } from "../../security/safe-http.ts";
import { discordAdapter } from "./adapters/discord.ts";
import { emailAdapter } from "./adapters/email.ts";
import { ntfyAdapter } from "./adapters/ntfy.ts";
import { slackAdapter } from "./adapters/slack.ts";
import type { ChannelAdapter } from "./adapters/types.ts";
import {
	ACK_PATH,
	ACK_VERIFY_ACTION,
	ackBaseUrl,
	ackToken,
	hashAckToken,
	takeRateToken,
	VERIFY_TTL_MS,
} from "./capability.ts";
import { DISCORD_INTERACTIONS_PATH } from "./discord-interactions.ts";
import { SLACK_INTERACTIONS_PATH } from "./slack-interactions.ts";

type Database = NodePgDatabase<typeof tables>;

// Rows without an adapter are rendered disabled in the UI (shell doc 1) and are
// rejected here so a hand-rolled POST cannot store a config for a channel
// nothing can send on.
const IMPLEMENTED: Partial<Record<ChannelKind, ChannelAdapter>> = {
	ntfy: ntfyAdapter,
	discord: discordAdapter,
	slack: slackAdapter,
	email: emailAdapter,
};

const CHANNEL_KINDS = new Set<string>(tables.channelKindEnum.enumValues);

// Bounds the client-controlled JSONB, mirroring the M1b/M1c input-cap posture.
const MAX_FIELDS = 20;
const MAX_VALUE_LENGTH = 2_048;

// Test-send fires a real outbound request at a user-supplied serverUrl, so an
// authenticated caller could otherwise drive unbounded traffic at arbitrary
// public hosts through this instance. Same token bucket the ack route uses,
// keyed per user rather than per IP (the caller is authenticated here).
// A burst of 5, refilling one per minute: enough to iterate on a config, far
// too slow to be a traffic source.
export const TEST_SEND_CAPACITY = 5;
export const TEST_SEND_REFILL_PER_SEC = 1 / 60;

// A stable, closed code rather than the prose. The route hands this to the
// client, which renders it through messages.ts: the prose named deployment env
// vars ("set DITERO_PUBLIC_URL first") to non-admin users and was untranslatable
// by construction. The message stays as the server-log/throw detail.
export type ChannelErrorCodeOut =
	| "unknown_kind"
	| "not_implemented"
	| "invalid_config"
	| "no_stored_config"
	| "app_mode_unsupported"
	| "email_unsupported"
	| "rate_limited";

export class ChannelError extends Error {
	constructor(
		readonly code: ChannelErrorCodeOut,
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

// A closed set of user-safe categories. Never a passthrough of the provider
// response or of delivery_attempt.error, both of which can carry the channel
// URL or the token (shell doc 1).
export type TestFailure =
	| "Could not reach the server"
	| "Server rejected the request"
	| "Request timed out";

export type ChannelView = {
	kind: ChannelKind;
	enabled: boolean;
	verifiedAt: number | null;
	// Non-null only once a verify capability was redeemed through this channel:
	// "sent" and "acknowledged" are different claims and the row must not merge
	// them (shell doc 5).
	ackVerifiedAt: number | null;
	config: Record<string, unknown>;
};

export type ChannelDeps = {
	adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
	fetch?: typeof safeFetch;
	env?: NodeJS.ProcessEnv;
	// Test seams for the per-user send budget; production uses the constants.
	rateCapacity?: number;
	rateRefillPerSec?: number;
};

function requireKind(value: unknown): ChannelKind {
	if (typeof value !== "string" || !CHANNEL_KINDS.has(value)) {
		throw new ChannelError("unknown_kind", "unknown channel kind", 400);
	}
	if (!IMPLEMENTED[value as ChannelKind]) {
		throw new ChannelError("not_implemented", "channel not available yet", 400);
	}
	return value as ChannelKind;
}

function requireConfig(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ChannelError("invalid_config", "config must be an object", 400);
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length > MAX_FIELDS) {
		throw new ChannelError("invalid_config", "config has too many fields", 400);
	}
	for (const [, field] of entries) {
		if (typeof field === "string" && field.length > MAX_VALUE_LENGTH) {
			throw new ChannelError("invalid_config", "config field is too long", 400);
		}
	}
	return Object.fromEntries(entries);
}

// Design 3.1: an app-mode button is acked through an interactions endpoint on
// this deployment's own public origin. With no public base URL there is no
// endpoint to register and no ack link to fall back to, so the mode is refused
// at save rather than stored and left silently non-interactive -- which is the
// same invisible failure the webhook-mode type guard exists to prevent.
// ackBaseUrl is the codebase's only notion of "public origin"; reused, not
// re-derived.
function requireInteractiveSupport(
	config: Record<string, unknown>,
	env: NodeJS.ProcessEnv,
): void {
	if (config.mode !== "app") return;
	if (ackBaseUrl(env) === null) {
		throw new ChannelError(
			"app_mode_unsupported",
			"app mode needs a public base URL: set DITERO_PUBLIC_URL first",
			400,
		);
	}
}

// Same shape as requireInteractiveSupport, and for the same reason: the SMTP
// host, port and credentials are operator env (design 3.3), so on a deployment
// with no SMTP an email channel could be saved, look configured in the settings
// page, and silently never deliver. Refused at save with the setting to fix.
function requireMailSupport(kind: ChannelKind, env: NodeJS.ProcessEnv): void {
	if (kind !== "email") return;
	if (!isMailConfigured(env)) {
		throw new ChannelError(
			"email_unsupported",
			"email needs an SMTP server: set DITERO_SMTP_HOST first",
			400,
		);
	}
}

function canonical(config: Record<string, unknown>): string {
	return JSON.stringify(
		Object.fromEntries(
			Object.entries(config).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
		),
	);
}

async function storedConfig(
	database: Database,
	userId: string,
	kind: ChannelKind,
	env: NodeJS.ProcessEnv,
): Promise<Record<string, unknown> | null> {
	const rows = await database
		.select({ config: tables.notificationChannel.config })
		.from(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.userId, userId),
				eq(tables.notificationChannel.kind, kind),
			),
		)
		.limit(1);
	if (rows.length === 0) return null;
	return decryptChannelConfig(
		kind,
		rows[0].config as Record<string, unknown>,
		channelKeyRing(env),
	);
}

// What the settings page is allowed to know about this deployment: booleans and
// enums only, never the env values. Three of the UI's documented states
// (app mode with no public URL, SMTP absent, Telegram set to webhook without
// one) are otherwise underivable client-side, and the alternative -- letting the
// user fill in a form the save path will reject -- is worse.
export type ChannelCapabilities = {
	ackBaseUrl: boolean;
	email: boolean;
	telegramTransport: TelegramMode;
	// Whether the selected transport CAN be run here, not whether it currently
	// works: a registered-but-failing webhook is indistinguishable from a healthy
	// one at this layer, and the name must not claim otherwise. Wiring Task 6's
	// registration result in would be the upgrade.
	telegramWebhookConfigurable: boolean;
};

export function channelCapabilities(
	env: NodeJS.ProcessEnv = process.env,
): ChannelCapabilities {
	const base = ackBaseUrl(env) !== null;
	const transport = telegramMode(env);
	return {
		ackBaseUrl: base,
		email: isMailConfigured(env),
		telegramTransport: transport,
		// A webhook cannot be registered without a public origin to register, so
		// the operator has selected a transport this deployment cannot run.
		telegramWebhookConfigurable: transport === "poll" || base,
	};
}

// The one deployment string the client does get, because the user has to paste
// it into the provider's app settings, so it is public by construction.
export function interactionsUrls(
	env: NodeJS.ProcessEnv = process.env,
): { discord: string; slack: string } | null {
	const base = ackBaseUrl(env);
	if (base === null) return null;
	const origin = base.replace(/\/+$/, "");
	return {
		discord: `${origin}${DISCORD_INTERACTIONS_PATH}`,
		slack: `${origin}${SLACK_INTERACTIONS_PATH}`,
	};
}

// Deliberately does NOT decrypt: the mask replaces every non-public field
// whatever it holds, so decrypting first would materialize every user's
// plaintext credentials in memory for a page that only ever renders `***`, and
// would make the settings page throw on a missing or wrong key.
export async function listChannels(
	database: Database,
	userId: string,
): Promise<ChannelView[]> {
	const rows = await database
		.select()
		.from(tables.notificationChannel)
		.where(eq(tables.notificationChannel.userId, userId));
	return rows.map((row) => ({
		kind: row.kind,
		enabled: row.enabled,
		verifiedAt: row.verifiedAt?.getTime() ?? null,
		ackVerifiedAt: row.ackVerifiedAt?.getTime() ?? null,
		config: maskChannelConfig(row.kind, row.config as Record<string, unknown>),
	}));
}

// Returns the effective (decrypted) config alongside the stored view, so
// test-send can send what it just persisted without a second read.
async function upsertChannel(
	database: Database,
	userId: string,
	body: unknown,
	env: NodeJS.ProcessEnv,
): Promise<{ view: ChannelView; config: Record<string, unknown> }> {
	const input = requireConfig(body);
	const kind = requireKind(input.kind);
	requireMailSupport(kind, env);
	const enabled = input.enabled === undefined ? true : input.enabled === true;
	const previous = await storedConfig(database, userId, kind, env);

	// `config` omitted means "flip enabled only": the settings toggle must not
	// smuggle whatever half-typed edit is sitting in the form into the stored
	// row, nor reset verified_at through the changed-config branch below.
	if (input.config === undefined) {
		if (previous === null) {
			throw new ChannelError(
				"no_stored_config",
				"no stored config to update",
				400,
			);
		}
		const [only] = await database
			.update(tables.notificationChannel)
			.set({ enabled, updatedAt: new Date() })
			.where(
				and(
					eq(tables.notificationChannel.userId, userId),
					eq(tables.notificationChannel.kind, kind),
				),
			)
			.returning();
		return {
			view: {
				kind: only.kind,
				enabled: only.enabled,
				verifiedAt: only.verifiedAt?.getTime() ?? null,
				ackVerifiedAt: only.ackVerifiedAt?.getTime() ?? null,
				config: maskChannelConfig(kind, previous),
			},
			config: previous,
		};
	}
	const incoming = requireConfig(input.config);

	// Restore BEFORE validation: the schema rejects the literal MASKED value.
	const restored = restoreChannelConfig(
		kind,
		incoming,
		previous ? { kind, config: previous } : null,
	);
	const parsed = channelConfigSchema[kind].safeParse(restored);
	if (!parsed.success) {
		throw new ChannelError("invalid_config", "invalid channel config", 400);
	}
	const config = parsed.data as Record<string, unknown>;
	requireInteractiveSupport(config, env);
	const stored = encryptChannelConfig(kind, config, channelKeyRing(env));
	// A changed config invalidates the previous verification: the old
	// verified_at described a server/topic/token combination that no longer
	// exists. Compared key-order-insensitively because `previous` came back
	// through JSONB, which normalises key order, while `config` carries the Zod
	// shape's -- a plain JSON.stringify made every save look changed.
	const changed =
		previous === null || canonical(previous) !== canonical(config);

	const [row] = await database
		.insert(tables.notificationChannel)
		.values({ id: randomUUID(), userId, kind, config: stored, enabled })
		.onConflictDoUpdate({
			target: [
				tables.notificationChannel.userId,
				tables.notificationChannel.kind,
			],
			set: {
				config: stored,
				enabled,
				updatedAt: new Date(),
				...(changed ? { verifiedAt: null, ackVerifiedAt: null } : {}),
			},
		})
		.returning();

	// Nulling verified_at is only half of it: a verify capability is bound to
	// (recipient, kind) and nothing else, so an outstanding one minted against the
	// OLD config would stamp the new one verified without ever having reached it.
	// Same invalidation, same branch.
	if (changed) {
		await database
			.delete(tables.ackCapability)
			.where(
				and(
					eq(tables.ackCapability.recipientUserId, userId),
					eq(tables.ackCapability.channelKind, kind),
					eq(tables.ackCapability.action, ACK_VERIFY_ACTION),
					isNull(tables.ackCapability.consumedAt),
				),
			);
	}

	return {
		view: {
			kind: row.kind,
			enabled: row.enabled,
			verifiedAt: row.verifiedAt?.getTime() ?? null,
			ackVerifiedAt: row.ackVerifiedAt?.getTime() ?? null,
			config: maskChannelConfig(kind, config),
		},
		config,
	};
}

export async function saveChannel(
	database: Database,
	userId: string,
	body: unknown,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelView> {
	return (await upsertChannel(database, userId, body, env)).view;
}

export async function deleteChannel(
	database: Database,
	userId: string,
	body: unknown,
): Promise<{ deleted: boolean }> {
	const kind = requireKind(requireConfig(body).kind);
	const removed = await database
		.delete(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.userId, userId),
				eq(tables.notificationChannel.kind, kind),
			),
		)
		.returning({ id: tables.notificationChannel.id });
	return { deleted: removed.length > 0 };
}

function classify(result: {
	ok: boolean;
	status?: number;
	error?: string;
}): TestFailure {
	if (result.status !== undefined) return "Server rejected the request";
	if (result.error && /abort|timed? ?out/i.test(result.error)) {
		return "Request timed out";
	}
	return "Could not reach the server";
}

// Bound to (recipient, channel) rather than to a reminder: there is no
// occurrence to ack, and redeeming it stamps verified_at on this channel.
async function mintVerifyCapability(
	database: Database,
	userId: string,
	kind: ChannelKind,
	baseUrl: string | null,
): Promise<string | null> {
	if (baseUrl === null) return null;
	const token = ackToken();
	await database.insert(tables.ackCapability).values({
		id: randomUUID(),
		tokenHash: hashAckToken(token),
		reminderStateId: null,
		recipientUserId: userId,
		action: ACK_VERIFY_ACTION,
		channelKind: kind,
		expiresAt: new Date(Date.now() + VERIFY_TTL_MS),
	});
	return `${baseUrl.replace(/\/+$/, "")}${ACK_PATH}/${token}`;
}

// Persists first, then sends: verified_at describes the STORED config, so
// marking a config verified that was never stored would let the settings page
// claim a green check for something the scheduler will never use. The form's
// unsaved edit is still what gets tested (shell doc 1) -- saving it is what
// makes that honest.
export async function testChannel(
	database: Database,
	userId: string,
	body: unknown,
	deps: ChannelDeps = {},
): Promise<
	{ ok: true; verifiedAt: number } | { ok: false; reason: TestFailure }
> {
	const env = deps.env ?? process.env;
	// Budget is spent BEFORE the config is persisted: a caller who has run out
	// must not be able to keep rewriting the row either.
	const allowed = await takeRateToken(
		database,
		`channel-test:${userId}`,
		deps.rateCapacity ?? TEST_SEND_CAPACITY,
		deps.rateRefillPerSec ?? TEST_SEND_REFILL_PER_SEC,
	);
	if (!allowed) {
		throw new ChannelError(
			"rate_limited",
			"too many test sends, try again shortly",
			429,
		);
	}
	const { view, config } = await upsertChannel(database, userId, body, env);
	const adapter = (deps.adapters ?? IMPLEMENTED)[view.kind];
	if (!adapter)
		throw new ChannelError("not_implemented", "channel not available yet", 400);

	// Minted before the send so the test message carries a real, single-use
	// Acknowledge button: in an interactive mode the outbound leg is exactly the
	// half that can succeed while the button was silently dropped.
	const ackUrl = await mintVerifyCapability(
		database,
		userId,
		view.kind,
		ackBaseUrl(env),
	);
	const timing = workerTiming(env);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timing.adapterDeadlineMs);
	let result: { ok: boolean; status?: number; error?: string };
	try {
		result = await adapter.send(
			config,
			{
				title: "Ditero test",
				body: "Test notification from Ditero.",
				urgent: false,
				ackUrl,
			},
			{
				allowedPrivateCIDRs: notifyAllowedPrivateCIDRs(
					env.DITERO_NOTIFY_ALLOWED_PRIVATE_CIDRS,
				),
				deadlineMs: timing.adapterDeadlineMs,
				signal: controller.signal,
				fetch: deps.fetch,
			},
		);
	} finally {
		clearTimeout(timer);
	}

	if (!result.ok) return { ok: false, reason: classify(result) };

	const verifiedAt = new Date();
	await database
		.update(tables.notificationChannel)
		.set({ verifiedAt })
		.where(
			and(
				eq(tables.notificationChannel.userId, userId),
				eq(tables.notificationChannel.kind, view.kind),
			),
		);
	return { ok: true, verifiedAt: verifiedAt.getTime() };
}
