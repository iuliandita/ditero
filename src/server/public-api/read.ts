import type { PoolClient } from "pg";
import {
	apiResult,
	PUBLIC_API_ID,
	PublicApiError,
} from "../../domain/public-api.ts";
import {
	publicApiProfileSchema,
	publicApiResourceSchemas,
} from "../../domain/public-api-resources.ts";
import {
	encodePageCursor,
	type PageQuery,
	type PublicApiResource,
} from "./contracts.ts";
import type { ApiActor } from "./tokens.ts";

type ResourceQuery = {
	from: string;
	fields: string;
	access: string;
	workspace: string;
};
const RESOURCES: Record<PublicApiResource, ResourceQuery> = {
	workspaces: {
		from: "workspace r",
		fields:
			'r.id, r.name, r.kind, r.owner_id as "ownerId", (select m.role from membership m where m.workspace_id = r.id and m.user_id = $1) as role',
		access:
			"exists (select 1 from membership m where m.workspace_id = r.id and m.user_id = $1)",
		workspace: "r.id",
	},
	lists: {
		from: "list r",
		fields:
			'r.id, r.workspace_id as "workspaceId", r.owner_id as "ownerId", r.title, r.kind, r.icon, r.folder_id as "folderId", r.sort_key as "sortKey", r.completed_display as "completedDisplay"',
		access:
			"exists (select 1 from membership m where m.workspace_id = r.workspace_id and m.user_id = $1)",
		workspace: "r.workspace_id",
	},
	tasks: {
		from: "task r join list l on l.id = r.list_id",
		fields: `r.id, r.list_id as "listId", l.workspace_id as "workspaceId", r.title, r.done, r.notes, r.due_at as "dueAt", r.due_all_day as "dueAllDay", r.priority, r.completed_at as "completedAt", r.created_at as "createdAt", r.sort_key as "sortKey", r.parent_id as "parentId", r.quantity, r.unit, r.category, r.rrule, r.recurrence_relative as "recurrenceRelative", r.reminder_time as "reminderTime",
		(select coalesce(json_agg(a.user_id order by a.user_id), '[]') from task_assignee a where a.task_id = r.id) as "assigneeIds",
		(select coalesce(json_agg(tl.label_id order by tl.label_id), '[]') from task_label tl where tl.task_id = r.id) as "labelIds"`,
		access:
			"exists (select 1 from membership m where m.workspace_id = l.workspace_id and m.user_id = $1)",
		workspace: "l.workspace_id",
	},
	people: {
		from: '"user" r',
		fields: `r.id, r.name, r.image, (select coalesce(json_agg(other.workspace_id order by other.workspace_id), '[]')
			from membership own join membership other on other.workspace_id = own.workspace_id
			where own.user_id = $1 and other.user_id = r.id and ($2::text is null or own.workspace_id = $2)) as "workspaceIds"`,
		access: `r.deleted_at is null and exists (select 1 from membership own join membership other on other.workspace_id = own.workspace_id
		where own.user_id = $1 and other.user_id = r.id and ($2::text is null or own.workspace_id = $2))`,
		workspace: "null::text",
	},
	labels: {
		from: "label r",
		fields: 'r.id, r.workspace_id as "workspaceId", r.name, r.color',
		access:
			"exists (select 1 from membership m where m.workspace_id = r.workspace_id and m.user_id = $1)",
		workspace: "r.workspace_id",
	},
	views: {
		from: "view r",
		fields:
			'r.id, r.owner_id as "ownerId", r.workspace_id as "workspaceId", r.scope, r.name, r.icon, r.filter, r.display',
		access:
			"(r.scope = 'personal' and r.owner_id = $1) or (r.scope = 'workspace' and exists (select 1 from membership m where m.workspace_id = r.workspace_id and m.user_id = $1))",
		workspace: "r.workspace_id",
	},
	dashboards: {
		from: "dashboard r",
		fields:
			'r.id, r.owner_id as "ownerId", r.workspace_id as "workspaceId", r.scope, r.name, r.icon, r.panels',
		access:
			"(r.scope = 'personal' and r.owner_id = $1) or (r.scope = 'workspace' and exists (select 1 from membership m where m.workspace_id = r.workspace_id and m.user_id = $1))",
		workspace: "r.workspace_id",
	},
};

export async function readApiResource(
	client: PoolClient,
	actor: ApiActor,
	resource: PublicApiResource,
	query: PageQuery,
	id?: string,
): Promise<Response> {
	if (id !== undefined && !PUBLIC_API_ID.safeParse(id).success)
		throw new PublicApiError(400, "invalid-id", "Invalid resource ID");
	const spec = RESOURCES[resource];
	const filter =
		resource === "people"
			? "true"
			: `($2::text is null or ${spec.workspace} = $2)`;
	const taskFilter =
		resource === "tasks"
			? "and ($5::text is null or r.list_id = $5) and ($6::boolean is null or r.done = $6)"
			: "";
	const args: unknown[] = [
		actor.userId,
		query.workspaceId,
		id ?? query.after,
		id ? 1 : query.limit + 1,
	];
	if (resource === "tasks") args.push(query.listId, query.done);
	const rows = await client.query<Record<string, unknown> & { id: string }>(
		`select ${spec.fields} from ${spec.from}
		where (${spec.access}) and ${filter}
		and ($3::text is null or r.id collate "C" ${id ? "=" : ">"} $3 collate "C") ${taskFilter}
		order by r.id collate "C" limit $4`,
		args,
	);
	if (id) {
		if (!rows.rowCount)
			throw new PublicApiError(404, "not-found", "Resource not found");
		return apiResult(
			publicApiResourceSchemas[resource].parse(
				JSON.parse(JSON.stringify(rows.rows[0])),
			),
		);
	}
	const data = rows.rows.slice(0, query.limit);
	const nextCursor =
		rows.rows.length > query.limit
			? encodePageCursor(resource, query, data[data.length - 1].id)
			: null;
	return apiResult(
		data.map((row) =>
			publicApiResourceSchemas[resource].parse(JSON.parse(JSON.stringify(row))),
		),
		nextCursor,
	);
}

export async function readApiProfile(
	client: PoolClient,
	actor: ApiActor,
): Promise<Response> {
	const profile = await client.query(
		`select u.id, u.name,
		coalesce(p.timezone, 'UTC') as timezone, coalesce(p.timezone_chosen, false) as "timezoneChosen",
		coalesce(p.locale, 'en') as locale, statement_timestamp() as "serverTime"
		from "user" u left join user_pref p on p.id = u.id where u.id = $1 and u.deleted_at is null`,
		[actor.userId],
	);
	if (!profile.rowCount)
		throw new PublicApiError(
			401,
			"unauthorized",
			"A valid personal access token is required",
		);
	return apiResult(
		publicApiProfileSchema.parse({
			...profile.rows[0],
			serverTime: profile.rows[0].serverTime.toISOString(),
			tokenAccess: actor.access,
		}),
	);
}
