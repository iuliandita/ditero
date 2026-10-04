import type { Pool, PoolClient } from "pg";
import { PublicApiError } from "../../domain/public-api.ts";
import {
	CALENDAR_MAX_TASK_TEXT_BYTES,
	CALENDAR_MAX_TASKS,
	type CalendarQuery,
	type CalendarTask,
	createCalendarSnapshot,
} from "../../domain/public-api-calendar.ts";
import { withPersonalAccessToken } from "./tokens.ts";

const unavailable = () =>
	new PublicApiError(503, "temporarily-unavailable", "Try again shortly");
const notFound = () =>
	new PublicApiError(404, "not-found", "Resource not found");
async function assertScope(
	client: PoolClient,
	userId: string,
	query: CalendarQuery,
) {
	if (
		query.workspaceId !== null &&
		!(
			await client.query(
				"select workspace_id from membership where user_id=$1 and workspace_id=$2",
				[userId, query.workspaceId],
			)
		).rowCount
	)
		throw notFound();
	if (
		query.listId !== null &&
		!(
			await client.query(
				"select l.id from list l join membership m on m.workspace_id=l.workspace_id where m.user_id=$1 and l.id=$2 and ($3::text is null or l.workspace_id=$3)",
				[userId, query.listId, query.workspaceId],
			)
		).rowCount
	)
		throw notFound();
}
export async function readCalendarSnapshot(
	client: PoolClient,
	userId: string,
	query: CalendarQuery,
): Promise<{ calendar: string; workspaces: string[]; check: () => void }> {
	const deadline = performance.now() + 5000;
	const check = () => {
		if (performance.now() >= deadline) throw unavailable();
	};
	await assertScope(client, userId, query);
	// One cursor statement snapshots tasks, membership and the caller's timezone together.
	await client.query(
		`declare api_calendar no scroll cursor for
  select t.id,case when octet_length(t.title)+coalesce(octet_length(t.notes),0)<=$4 then t.title else null end title,
  case when octet_length(t.title)+coalesce(octet_length(t.notes),0)<=$4 then t.notes else null end notes,
  octet_length(t.title)+coalesce(octet_length(t.notes),0) as "textBytes",
  t.due_at as "dueAt",t.due_all_day as "dueAllDay",t.done,t.completed_at as "completedAt",t.priority,
  l.workspace_id as "workspaceId",coalesce(p.timezone,'UTC') timezone,statement_timestamp() stamp
  from task t join list l on l.id=t.list_id join membership m on m.workspace_id=l.workspace_id and m.user_id=$1
  left join user_pref p on p.id=$1
  where ($2::text is null or l.workspace_id=$2) and ($3::text is null or l.id=$3)
  order by t.id collate "C" limit $5`,
		[
			userId,
			query.workspaceId,
			query.listId,
			CALENDAR_MAX_TASK_TEXT_BYTES,
			CALENDAR_MAX_TASKS + 1,
		],
	);
	let builder: ReturnType<typeof createCalendarSnapshot> | undefined;
	const workspaces = new Set<string>();
	let calendar: string;
	try {
		for (;;) {
			check();
			await client.query("select set_config('statement_timeout',$1,true)", [
				`${Math.max(1, Math.ceil(deadline - performance.now()))}ms`,
			]);
			const page = await client.query<
				CalendarTask & {
					textBytes: number;
					workspaceId: string;
					timezone: string;
					stamp: Date;
				}
			>("fetch forward 256 from api_calendar");
			check();
			if (!page.rowCount) break;
			for (const row of page.rows) {
				check();
				if (row.textBytes > CALENDAR_MAX_TASK_TEXT_BYTES)
					throw new PublicApiError(
						422,
						"calendar-too-large",
						"Narrow the calendar snapshot or reduce task text",
					);
				builder ??= createCalendarSnapshot(row.stamp, row.timezone);
				builder.add(row);
				workspaces.add(row.workspaceId);
			}
		}
		// An empty snapshot has no task row to carry timezone/stamp; it contains no date values.
		calendar = (builder ?? createCalendarSnapshot(new Date(), "UTC")).finish();
		check();
	} finally {
		await client.query("close api_calendar").catch((error: unknown) => {
			if (
				!(
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "25P02"
				)
			)
				throw error;
		});
	}
	return { calendar, workspaces: [...workspaces], check };
}
export function calendarResponse(calendar: string): Response {
	return new Response(calendar, {
		headers: {
			"content-type": "text/calendar; charset=utf-8",
			"content-disposition": 'attachment; filename="ditero-tasks.ics"',
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		},
	});
}
export function downloadApiCalendar(
	pool: Pool,
	token: string | null,
	query: CalendarQuery,
): Promise<Response> {
	return withPersonalAccessToken(pool, token, "read", async (client, actor) => {
		const { calendar, workspaces, check } = await readCalendarSnapshot(
			client,
			actor.userId,
			query,
		);
		await assertScope(client, actor.userId, query);
		const memberships = await client.query(
			"select workspace_id from membership where user_id=$1 and workspace_id=any($2::text[]) for share",
			[actor.userId, workspaces],
		);
		if (memberships.rowCount !== workspaces.length) throw notFound();
		const valid = await client.query(
			`select p.id from personal_access_token p join "user" u on u.id=p.user_id
  where p.id=$1 and p.user_id=$2 and p.revoked_at is null and p.expires_at>statement_timestamp() and u.deleted_at is null`,
			[actor.tokenId, actor.userId],
		);
		if (!valid.rowCount)
			throw new PublicApiError(
				401,
				"unauthorized",
				"A valid personal access token is required",
			);
		check();
		return calendarResponse(calendar);
	});
}
