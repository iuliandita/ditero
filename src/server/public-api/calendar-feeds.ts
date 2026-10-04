import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
	UserContextError,
	withLiveUserContext,
	withUserContext,
} from "../../db/user-context.ts";
import { PublicApiError } from "../../domain/public-api.ts";
import {
	CALENDAR_FEED_ACTIVE_LIMIT,
	CALENDAR_FEED_PREFIX,
	calendarFeedPath,
	parseCalendarFeedCreate,
	validCalendarFeedSecret,
} from "../../domain/public-api-calendar-feed.ts";
import { calendarResponse, readCalendarSnapshot } from "./calendar.ts";

type FeedMetadata = {
	id: string;
	name: string;
	hint: string;
	listId: string;
	workspaceId: string;
	createdAt: Date;
	expiresAt: Date;
	revokedAt: Date | null;
};
const fields = `id,name,hint,list_id as "listId",workspace_id as "workspaceId",created_at as "createdAt",expires_at as "expiresAt",revoked_at as "revokedAt"`;
const hashSecret = (secret: string) =>
	createHash("sha256").update(secret).digest("hex");
const unavailable = () =>
	new PublicApiError(404, "not-found", "Calendar feed not found");
async function lockScope(
	client: PoolClient,
	userId: string,
	listId: string,
	workspaceId: string,
) {
	const workspace = await client.query(
		"select id from workspace where id=$1 for share",
		[workspaceId],
	);
	const membership = await client.query(
		"select id from membership where user_id=$1 and workspace_id=$2 for share",
		[userId, workspaceId],
	);
	const list = await client.query(
		"select id from list where id=$1 and workspace_id=$2 for share",
		[listId, workspaceId],
	);
	if (
		workspace.rowCount !== 1 ||
		membership.rowCount !== 1 ||
		list.rowCount !== 1
	)
		throw unavailable();
}
export async function createCalendarFeed(
	pool: Pool,
	userId: string,
	input: unknown,
) {
	const parsed = parseCalendarFeedCreate(input);
	return withUserContext(pool, userId, async (client) => {
		await client.query(
			"select set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)",
		);
		const live = await client.query(
			'select id from "user" where id=$1 and deleted_at is null for update',
			[userId],
		);
		if (live.rowCount !== 1) throw new UserContextError();
		const list = await client.query<{ workspaceId: string }>(
			`select l.workspace_id as "workspaceId" from list l join membership m on m.workspace_id=l.workspace_id where l.id=$1 and m.user_id=$2`,
			[parsed.listId, userId],
		);
		if (list.rowCount !== 1) throw unavailable();
		const workspaceId = list.rows[0].workspaceId;
		await lockScope(client, userId, parsed.listId, workspaceId);
		const count = await client.query<{ count: number }>(
			"select count(*)::integer count from calendar_feed where user_id=$1 and revoked_at is null and expires_at>statement_timestamp()",
			[userId],
		);
		if (count.rows[0].count >= CALENDAR_FEED_ACTIVE_LIMIT)
			throw new PublicApiError(
				409,
				"feed-limit",
				"Revoke an active calendar feed before creating another",
			);
		const secret = `${CALENDAR_FEED_PREFIX}${randomBytes(32).toString("base64url")}`;
		const result = await client.query<FeedMetadata>(
			`insert into calendar_feed(id,user_id,list_id,workspace_id,name,secret_hash,hint,created_at,expires_at) values($1,$2,$3,$4,$5,$6,$7,statement_timestamp(),statement_timestamp()+make_interval(days=>$8)) returning ${fields}`,
			[
				randomUUID(),
				userId,
				parsed.listId,
				workspaceId,
				parsed.name,
				hashSecret(secret),
				secret.slice(-4),
				parsed.expiresInDays,
			],
		);
		return { ...result.rows[0], secret, path: calendarFeedPath(secret) };
	});
}
export async function listCalendarFeeds(pool: Pool, userId: string) {
	return withLiveUserContext(
		pool,
		userId,
		async (client) =>
			(
				await client.query<FeedMetadata>(
					`select ${fields} from calendar_feed where user_id=$1 order by (revoked_at is null and expires_at>statement_timestamp()) desc,created_at desc,id limit 100`,
					[userId],
				)
			).rows,
	);
}
export async function revokeCalendarFeed(
	pool: Pool,
	userId: string,
	id: string,
) {
	return withLiveUserContext(pool, userId, async (client) => {
		await client.query(
			"select set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true)",
		);
		const row = await client.query(
			"update calendar_feed set revoked_at=coalesce(revoked_at,statement_timestamp()) where id=$1 and user_id=$2 returning id",
			[id, userId],
		);
		if (row.rowCount !== 1) throw unavailable();
		return { id, revoked: true };
	});
}
export async function downloadCalendarFeed(pool: Pool, secret: string) {
	if (!validCalendarFeedSecret(secret)) throw unavailable();
	const client = await pool.connect();
	try {
		await client.query("begin");
		await client.query(
			"select set_config('statement_timeout','5000',true),set_config('lock_timeout','1000',true),set_config('ditero.calendar_feed_hash',$1,true)",
			[hashSecret(secret)],
		);
		const initial = await client.query<{
			id: string;
			userId: string;
			listId: string;
			workspaceId: string;
		}>(
			`select id,user_id as "userId",list_id as "listId",workspace_id as "workspaceId" from calendar_feed where secret_hash=$1 and revoked_at is null and expires_at>statement_timestamp()`,
			[hashSecret(secret)],
		);
		const feed = initial.rows[0];
		if (!feed) throw unavailable();
		const live = await client.query(
			'select id from "user" where id=$1 and deleted_at is null for share',
			[feed.userId],
		);
		if (live.rowCount !== 1) throw unavailable();
		await client.query(
			"select set_config('ditero.user_id',$1,true),set_config('ditero.calendar_feed_hash','',true)",
			[feed.userId],
		);
		await lockScope(client, feed.userId, feed.listId, feed.workspaceId);
		const valid = await client.query(
			"select id from calendar_feed where id=$1 and user_id=$2 and list_id=$3 and workspace_id=$4 and secret_hash=$5 and revoked_at is null and expires_at>statement_timestamp() for share",
			[feed.id, feed.userId, feed.listId, feed.workspaceId, hashSecret(secret)],
		);
		if (valid.rowCount !== 1) throw unavailable();
		const { calendar, check } = await readCalendarSnapshot(
			client,
			feed.userId,
			{ listId: feed.listId, workspaceId: feed.workspaceId },
		);
		await lockScope(client, feed.userId, feed.listId, feed.workspaceId);
		const final = await client.query(
			"select id from calendar_feed where id=$1 and revoked_at is null and expires_at>clock_timestamp()",
			[feed.id],
		);
		if (final.rowCount !== 1) throw unavailable();
		check();
		await client.query("commit");
		return calendarResponse(calendar);
	} catch (error) {
		await client.query("rollback");
		throw error;
	} finally {
		client.release();
	}
}
