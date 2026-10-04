import { z } from "zod";
import { PUBLIC_API_ID, PublicApiError } from "./public-api.ts";

export const CALENDAR_FEED_PREFIX = "ditero_feed_";
export const CALENDAR_FEED_ACTIVE_LIMIT = 20;
export const calendarFeedCreateSchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.refine(
				(value) =>
					value.isWellFormed() &&
					!Array.from(value).some((character) => {
						const code = character.codePointAt(0) ?? 0;
						return code < 32 || (code >= 127 && code <= 159);
					}),
			),
		listId: PUBLIC_API_ID,
		expiresInDays: z.number().int().min(1).max(365).default(90),
	})
	.strict();
export function parseCalendarFeedCreate(input: unknown) {
	const parsed = calendarFeedCreateSchema.safeParse(input);
	if (!parsed.success)
		throw new PublicApiError(
			400,
			"invalid-feed-request",
			"Invalid calendar feed name, list or lifetime",
		);
	return parsed.data;
}
export function validCalendarFeedSecret(secret: string): boolean {
	return /^ditero_feed_[A-Za-z0-9_-]{43}$/.test(secret);
}
export function calendarFeedPath(secret: string): string {
	if (!validCalendarFeedSecret(secret))
		throw new Error("Invalid calendar feed secret");
	return `/api/v1/calendar-feeds/${secret}/calendar.ics`;
}

export const calendarFeedMetadataSchema = z
	.object({
		id: z.uuid(),
		name: z.string(),
		hint: z.string().length(4),
		listId: PUBLIC_API_ID,
		workspaceId: PUBLIC_API_ID,
		createdAt: z.iso.datetime(),
		expiresAt: z.iso.datetime(),
		revokedAt: z.iso.datetime().nullable(),
	})
	.strict();
export const calendarFeedCreatedSchema = calendarFeedMetadataSchema
	.extend({
		secret: z.string().regex(/^ditero_feed_[A-Za-z0-9_-]{43}$/),
		path: z
			.string()
			.regex(
				/^\/api\/v1\/calendar-feeds\/ditero_feed_[A-Za-z0-9_-]{43}\/calendar\.ics$/,
			),
	})
	.strict();
