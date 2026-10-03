import { Elysia } from "elysia";
import type { Pool } from "pg";
import { UserContextError, withLiveUserContext } from "../db/user-context.ts";
import { COMPLETION_HISTORY_PAGE_SIZE } from "../domain/completion-history.ts";
import {
	type HistoryCursor,
	type HistoryPage,
	type HistoryRow,
	parseHistoryCursor,
} from "../domain/task-history.ts";
import type { Guards } from "./guards.ts";

type DatabaseHistoryRow = {
	id: string;
	at: Date;
	source_kind: HistoryRow["sourceKind"];
	action: HistoryRow["action"];
	mechanism: HistoryRow["origin"]["mechanism"];
	origin_label: string | null;
	origin_kind: HistoryRow["origin"]["kind"];
	actor_kind: HistoryRow["actor"]["kind"];
	actor_name: string | null;
	before_due_at: Date | null;
	before_due_all_day: boolean | null;
	habit_date: string | null;
	after_habit_status: HistoryRow["afterHabitStatus"];
	redacted_at: Date | null;
};

export class HistoryUnavailableError extends Error {}
export async function readTaskHistory(
	pool: Pool,
	userId: string,
	taskId: string,
	workspaceId: string,
	cursor: HistoryCursor | null,
): Promise<HistoryPage> {
	return withLiveUserContext(pool, userId, async (client) => {
		await client.query("set local statement_timeout = '5s'");
		const scope = (
			await client.query<{ list_id: string; workspace_id: string }>(
				"select t.list_id,l.workspace_id from task t join list l on l.id=t.list_id where t.id=$1",
				[taskId],
			)
		).rows[0];
		if (!scope || scope.workspace_id !== workspaceId)
			throw new HistoryUnavailableError();
		const workspace = await client.query(
			"select id from workspace where id=$1 for share",
			[workspaceId],
		);
		const member = await client.query(
			"select id from membership where workspace_id=$1 and user_id=$2 for share",
			[workspaceId, userId],
		);
		if (workspace.rowCount !== 1 || member.rowCount !== 1)
			throw new HistoryUnavailableError();
		const list = await client.query(
			"select id from list where id=$1 and workspace_id=$2 for share",
			[scope.list_id, workspaceId],
		);
		const task = await client.query(
			"select id from task where id=$1 and list_id=$2 for share",
			[taskId, scope.list_id],
		);
		if (list.rowCount !== 1 || task.rowCount !== 1)
			throw new HistoryUnavailableError();
		// One limit applies after the total ordering, including equal-time source boundaries.
		const result = await client.query<DatabaseHistoryRow>(
			`select * from (
    select e.id,e.recorded_at as at,'native'::text as source_kind,
      e.action,e.origin as mechanism,null::text as origin_label,'native'::text as origin_kind,
      case when u.name is null then 'unknown' else 'native_user' end as actor_kind,left(u.name,512) as actor_name,
      e.before_due_at,e.before_due_all_day,e.habit_date,e.after_habit_status,null::timestamptz as redacted_at
    from task_completion_event e left join "user" u on u.id=e.actor_user_id and u.deleted_at is null where e.task_id=$1
    union all
    select e.id,e.occurred_at,'imported',e.action,e.origin_mechanism,e.origin_label,e.origin_kind,
      e.actor_kind,e.actor_name,e.before_due_at,e.before_due_all_day,e.habit_date,e.after_habit_status,e.provenance_redacted_at
    from imported_completion_event e where e.task_id=$1
   ) history where ($2::timestamptz is null or
     (at,source_kind collate "C",id collate "C") < ($2::timestamptz,$3::text collate "C",$4::text collate "C"))
   order by at desc,source_kind collate "C" desc,id collate "C" desc limit $5`,
			[
				taskId,
				cursor ? new Date(cursor.recordedAt).toISOString() : null,
				cursor?.sourceKind ?? null,
				cursor?.id ?? null,
				COMPLETION_HISTORY_PAGE_SIZE,
			],
		);
		const rows = result.rows.map((value) => {
			const raw = value;
			return {
				id: raw.id,
				recordedAt: raw.at.getTime(),
				sourceKind: raw.source_kind,
				action: raw.action,
				origin: {
					kind: raw.origin_kind,
					mechanism: raw.mechanism,
					label: raw.origin_label,
				},
				actor: { kind: raw.actor_kind, displayName: raw.actor_name },
				beforeDueAt: raw.before_due_at?.getTime() ?? null,
				beforeDueAllDay: raw.before_due_all_day,
				habitDate: raw.habit_date,
				afterHabitStatus: raw.after_habit_status,
				provenanceRedactedAt: raw.redacted_at?.getTime() ?? null,
			};
		});
		const last = rows.at(-1);
		return {
			rows,
			nextCursor:
				rows.length === COMPLETION_HISTORY_PAGE_SIZE && last
					? {
							recordedAt: last.recordedAt,
							sourceKind: last.sourceKind,
							id: last.id,
						}
					: null,
		};
	});
}
export function taskHistoryRoutes(pool: Pool, guards: Guards) {
	return new Elysia().get(
		"/api/tasks/history",
		guards.guardedGet(async (request, session) => {
			const parameters = new URL(request.url).searchParams;
			let cursor: HistoryCursor | null;
			try {
				if (
					[...parameters.keys()].some(
						(key) => !["taskId", "workspaceId", "cursor"].includes(key),
					) ||
					["taskId", "workspaceId"].some(
						(key) =>
							parameters.getAll(key).length !== 1 ||
							(parameters.get(key)?.length ?? 0) > 2048,
					) ||
					parameters.getAll("cursor").length > 1
				)
					throw new Error("Invalid history request");
				cursor = parseHistoryCursor(parameters.get("cursor"));
			} catch {
				return Response.json(
					{ code: "invalid-history-request" },
					{ status: 400, headers: { "cache-control": "no-store" } },
				);
			}
			try {
				const page = await readTaskHistory(
					pool,
					session.user.id,
					parameters.get("taskId") ?? "",
					parameters.get("workspaceId") ?? "",
					cursor,
				);
				return Response.json(page, {
					headers: {
						"cache-control": "no-store",
						"x-content-type-options": "nosniff",
					},
				});
			} catch (error) {
				const status =
					error instanceof UserContextError
						? 401
						: error instanceof HistoryUnavailableError
							? 404
							: 503;
				if (status === 503)
					console.error("task history request failed", {
						category: "unexpected",
					});
				return Response.json(
					{
						code:
							status === 404
								? "history-unavailable"
								: status === 401
									? "unauthorized"
									: "history-load-failed",
					},
					{ status, headers: { "cache-control": "no-store" } },
				);
			}
		}),
	);
}
