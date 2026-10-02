// Recipient-facing lookups shared by the leader scan (scheduler.ts) and the
// event enqueue path (events.ts): both need the same preferences, the same
// enabled-channel fan-out, and the same never-suppress-on-a-broken-preference
// quiet-hours rule.
import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as tables from "../../db/schema.ts";
import type { Locale } from "../../domain/locale.ts";
import {
	type QuietDecision,
	quietHoursDecision,
} from "../../domain/quiet-hours.ts";
import { localeFromPref } from "../recipient-locale.ts";

type Database = NodePgDatabase<typeof tables>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type RecipientDatabase = Database | Transaction;

// Recipients come from server-side authority checks. Scope only the native
// owner rows needed for discovery, and preserve any enclosing caller context.
export async function withRecipientContext<T>(
	database: RecipientDatabase,
	userId: string,
	run: (tx: Transaction) => Promise<T>,
): Promise<T> {
	return database.transaction(async (tx) => {
		const { rows } = await tx.execute<{ user_id: string | null }>(
			sql`select current_setting('ditero.user_id', true) as user_id`,
		);
		await tx.execute(sql`select set_config('ditero.user_id', ${userId}, true)`);
		const result = await run(tx);
		await tx.execute(
			sql`select set_config('ditero.user_id', ${rows[0].user_id ?? ""}, true)`,
		);
		return result;
	});
}
type ChannelKind = (typeof tables.outboxDeliveryKindEnum.enumValues)[number];

export type Pref = {
	timezone: string;
	quietHours: unknown;
	escalationDefaults: unknown;
	// Carried on the enqueued payload so the send path renders in the recipient's
	// language without a second lookup per outbox row.
	locale: Locale;
};

export const DEFAULT_PREF: Pref = {
	timezone: "UTC",
	quietHours: null,
	escalationDefaults: null,
	locale: "en",
};

export async function loadPrefs(
	database: RecipientDatabase,
	userIds: string[],
): Promise<Map<string, Pref>> {
	const prefs = new Map<string, Pref>();
	if (userIds.length === 0) return prefs;
	const rows = await database
		.select({
			id: tables.userPref.id,
			timezone: tables.userPref.timezone,
			quietHours: tables.userPref.quietHours,
			escalationDefaults: tables.userPref.escalationDefaults,
			locale: tables.userPref.locale,
		})
		.from(tables.userPref)
		.where(inArray(tables.userPref.id, userIds));
	for (const row of rows) {
		prefs.set(row.id, {
			timezone: row.timezone,
			quietHours: row.quietHours,
			escalationDefaults: row.escalationDefaults,
			locale: localeFromPref(row.locale),
		});
	}
	return prefs;
}

export async function loadChannels(
	database: RecipientDatabase,
	userIds: string[],
): Promise<Map<string, ChannelKind[]>> {
	const channels = new Map<string, ChannelKind[]>();
	if (userIds.length === 0) return channels;
	const rows = await database
		.select({
			userId: tables.notificationChannel.userId,
			kind: tables.notificationChannel.kind,
		})
		.from(tables.notificationChannel)
		.where(
			and(
				inArray(tables.notificationChannel.userId, userIds),
				eq(tables.notificationChannel.enabled, true),
			),
		);
	for (const row of rows) {
		const list = channels.get(row.userId) ?? [];
		list.push(row.kind);
		channels.set(row.userId, list);
	}
	for (const userId of userIds) {
		const registrations = await withRecipientContext(
			database,
			userId,
			async (tx) => {
				const { rows } = await tx.execute<{ user_id: string }>(sql`
 select distinct r.user_id from native_push_registration r
 join session s on s.id=r.session_id and s.user_id=r.user_id
 join native_session_link l on l.session_id=s.id and l.user_id=r.user_id and l.device_id=r.device_id
 join user_device d on d.id=r.device_id and d.user_id=r.user_id
 where r.user_id=${userId} and s.expires_at > now() and d.revoked_at is null
 `);
				return rows;
			},
		);
		for (const row of registrations) {
			const list = channels.get(row.user_id) ?? [];
			list.push("nativepush");
			channels.set(row.user_id, list);
		}
	}
	return channels;
}

// Membership keys, `${userId}:${workspaceId}`. task_assignee rows and
// list.ownerId both survive a membership removal, so every notify path that
// derives recipients from them must re-check here or an ex-member keeps
// receiving task titles from a workspace they left.
export async function loadMemberships(
	database: RecipientDatabase,
	userIds: string[],
): Promise<Set<string>> {
	const members = new Set<string>();
	if (userIds.length === 0) return members;
	const rows = await database
		.select({
			userId: tables.membership.userId,
			workspaceId: tables.membership.workspaceId,
		})
		.from(tables.membership)
		.where(inArray(tables.membership.userId, userIds));
	for (const row of rows) members.add(`${row.userId}:${row.workspaceId}`);
	return members;
}

export function decideQuietHours(
	pref: Pref,
	urgent: boolean,
	at: Date,
	userId: string,
): QuietDecision {
	try {
		return quietHoursDecision(
			pref.quietHours as never,
			pref.timezone,
			at,
			urgent,
		);
	} catch (error) {
		// A broken preference must not silently suppress a notification.
		console.error(
			`notifications: unusable quiet hours for user ${userId}, firing anyway:`,
			error,
		);
		return { kind: "fire" };
	}
}
