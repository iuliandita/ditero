// Recipient locale for server-originated user-facing text (mail, notifications).
//
// The server must never fall back to the ambient runtime locale (Paraglide's
// getLocale): that state is process-global and races across concurrent requests
// and background jobs. Every server render passes an explicit locale instead,
// and this module is where that locale comes from.
//
// Fallback is `en` ALWAYS: an unknown, unsupported, or unset preference -- and a
// cold invite to someone who has no account yet -- all render in English. There
// is deliberately no operator override.
import { eq } from "drizzle-orm";
import type { db as defaultDb } from "../db/client.ts";
import { userPref } from "../db/schema.ts";
import { isSupportedLocale, type Locale } from "../domain/locale.ts";

type LocaleDb = Pick<typeof defaultDb, "select">;

// Pure: coerce a stored user_pref.locale value into a supported Locale or `en`.
// Shared with any fan-out path that already loaded the pref row, so it needs no
// second query there.
export function localeFromPref(value: string | null | undefined): Locale {
	return value != null && isSupportedLocale(value) ? value : "en";
}

export async function resolveRecipientLocale(
	database: LocaleDb,
	userId: string | null,
): Promise<Locale> {
	// Cold recipient (unregistered invitee): no stored preference exists.
	if (userId === null) return "en";
	try {
		const [row] = await database
			.select({ locale: userPref.locale })
			.from(userPref)
			.where(eq(userPref.id, userId))
			.limit(1);
		return localeFromPref(row?.locale);
	} catch (error) {
		// A locale lookup must never block or fail a send; English is the floor.
		console.error(
			`recipient locale: lookup for user ${userId} failed, using en:`,
			error instanceof Error ? error.name : "unknown",
		);
		return "en";
	}
}
