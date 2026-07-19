// Send side of the outbox. This is the SendFn the worker injects: it resolves
// the recipient's channel config, mints the ack capability, and hands a
// rendered payload to the channel adapter. It never throws -- the worker
// classifies a ProviderResult, and a rejection would be flattened into an
// untyped transport error that loses the permanent/retryable distinction.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import * as tables from "../../db/schema.ts";
import type { ChannelKind } from "../../domain/notification-channel.ts";
import type { safeFetch } from "../../security/safe-http.ts";
import type { Network } from "../client-ip.ts";
import { ntfyAdapter } from "./adapters/ntfy.ts";
import type { ChannelAdapter, ChannelPayload } from "./adapters/types.ts";
import { permanent } from "./adapters/types.ts";
import type { OutboxRow, SendFn } from "./worker.ts";

type Database = NodePgDatabase<typeof tables>;

// Path of the public capability route Task 13 mounts. Exported so the two sides
// cannot drift into minting links nobody serves.
export const ACK_PATH = "/api/notifications/ack";
// The only action minted today. Bindings are checked on consume, so a
// capability minted for one action must not redeem another (C27).
export const ACK_ACTION = "complete";
// Comfortably outlives the ~33-minute retry ladder and any escalation ladder,
// while bounding how long a leaked notification stays actionable.
export const ACK_TTL_MS = 24 * 3_600_000;

export function hashAckToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

// Only the reminder payload is modelled today; Task 14 adds the event shape.
// The `kind` literal is what is load-bearing: unknown payloads fail closed as
// permanently undeliverable rather than rendering an empty notification.
// Deliberately loose otherwise -- the scheduler carries fields this does not
// read, and rejecting them would couple the two sides for no gain.
const reminderPayloadSchema = z
	.object({
		kind: z.literal("reminder"),
		taskTitle: z.string(),
		occurrenceAt: z.string(),
		urgent: z.boolean().optional(),
	})
	.loose();

export type DispatchDeps = {
	database: Database;
	allowedPrivateCIDRs: readonly Network[];
	deadlineMs: number;
	// Absolute origin the ack link is built from, validated at construction.
	// Null disables the ack action entirely rather than emitting a relative URL
	// no push client can follow.
	ackBaseUrl: string | null;
	adapters?: Partial<Record<ChannelKind, ChannelAdapter>>;
	fetch?: typeof safeFetch;
};

const DEFAULT_ADAPTERS: Partial<Record<ChannelKind, ChannelAdapter>> = {
	ntfy: ntfyAdapter,
};

function renderPayload(raw: unknown): Omit<ChannelPayload, "ackUrl"> | null {
	const parsed = reminderPayloadSchema.safeParse(raw);
	if (!parsed.success) return null;
	return {
		title: parsed.data.taskTitle,
		// i18n: Task 15 renders this in the recipient's locale and timezone.
		body: `Due ${parsed.data.occurrenceAt}`,
		urgent: parsed.data.urgent === true,
	};
}

async function loadChannelConfig(
	database: Database,
	userId: string,
	kind: ChannelKind,
): Promise<{ config: unknown } | null> {
	const rows = await database
		.select({ config: tables.notificationChannel.config })
		.from(tables.notificationChannel)
		.where(
			and(
				eq(tables.notificationChannel.userId, userId),
				eq(tables.notificationChannel.kind, kind),
				eq(tables.notificationChannel.enabled, true),
			),
		)
		.limit(1);
	return rows.length === 0 ? null : { config: rows[0].config };
}

// Minted here rather than at enqueue (C21): the outbox payload is retained for
// up to 30 days, and a raw token in plaintext JSONB for that window defeats the
// hash-only storage rule. A retry mints a fresh capability; earlier ones stay
// valid until expiry, which is harmless because every one of them is bound to
// the same reminder, recipient and action, so any of them acking is correct.
async function mintAckUrl(
	database: Database,
	row: OutboxRow,
	ackBaseUrl: string | null,
): Promise<string | null> {
	// ack_capability.reminder_state_id is notNull and event rows (Task 14) carry
	// no reminder, so those get no ack action rather than a constraint violation.
	if (row.reminderStateId === null || ackBaseUrl === null) return null;
	const token = randomBytes(32).toString("base64url");
	await database.insert(tables.ackCapability).values({
		id: randomUUID(),
		tokenHash: hashAckToken(token),
		reminderStateId: row.reminderStateId,
		recipientUserId: row.recipientUserId,
		action: ACK_ACTION,
		expiresAt: new Date(Date.now() + ACK_TTL_MS),
	});
	return `${ackBaseUrl.replace(/\/+$/, "")}${ACK_PATH}/${token}`;
}

export function createSendFn(deps: DispatchDeps): SendFn {
	const adapters = deps.adapters ?? DEFAULT_ADAPTERS;
	// Fail at construction, not per notification: a malformed origin would
	// otherwise mint unfollowable ack links for every reminder, silently.
	if (deps.ackBaseUrl !== null) {
		try {
			new URL(deps.ackBaseUrl);
		} catch {
			throw new Error(
				`dispatch: ackBaseUrl must be an absolute URL, got "${deps.ackBaseUrl}"`,
			);
		}
	}
	return async (row: OutboxRow, signal: AbortSignal) => {
		try {
			const adapter = adapters[row.channelKind];
			// Permanent, not retryable: neither a missing adapter nor a channel the
			// user has since deleted or disabled resolves itself on a retry.
			if (!adapter) {
				return permanent(`dispatch: no adapter for channel ${row.channelKind}`);
			}
			const payload = renderPayload(row.payload);
			if (!payload) {
				return permanent(`dispatch: unrenderable payload on row ${row.id}`);
			}
			const channel = await loadChannelConfig(
				deps.database,
				row.recipientUserId,
				row.channelKind,
			);
			if (channel === null) {
				return permanent(
					`dispatch: ${row.channelKind} channel is not configured or is disabled`,
				);
			}
			const ackUrl = await mintAckUrl(deps.database, row, deps.ackBaseUrl);
			return await adapter.send(
				channel.config,
				{ ...payload, ackUrl },
				{
					allowedPrivateCIDRs: deps.allowedPrivateCIDRs,
					deadlineMs: deps.deadlineMs,
					signal,
					fetch: deps.fetch,
				},
			);
		} catch (error) {
			// An adapter that breaks its never-throw contract, or a failed
			// capability insert, must not strand the row in `sending` until its
			// lease expires.
			return {
				ok: false,
				error: `dispatch: ${error instanceof Error ? error.message : "unknown error"}`,
			};
		}
	};
}
