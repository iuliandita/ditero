// Recipient-facing lookups shared by the leader scan (scheduler.ts) and the
// event enqueue path (events.ts): both need the same preferences, the same
// enabled-channel fan-out, and the same never-suppress-on-a-broken-preference
// quiet-hours rule.
import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as tables from "../../db/schema.ts";
import {
	type QuietDecision,
	quietHoursDecision,
} from "../../domain/quiet-hours.ts";

type Database = NodePgDatabase<typeof tables>;
type ChannelKind = (typeof tables.channelKindEnum.enumValues)[number];

export type Pref = {
	timezone: string;
	quietHours: unknown;
	escalationDefaults: unknown;
};

export const DEFAULT_PREF: Pref = {
	timezone: "UTC",
	quietHours: null,
	escalationDefaults: null,
};

export async function loadPrefs(
	database: Database,
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
		})
		.from(tables.userPref)
		.where(inArray(tables.userPref.id, userIds));
	for (const row of rows) {
		prefs.set(row.id, {
			timezone: row.timezone,
			quietHours: row.quietHours,
			escalationDefaults: row.escalationDefaults,
		});
	}
	return prefs;
}

export async function loadChannels(
	database: Database,
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
	return channels;
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
