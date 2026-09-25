import type { Transaction } from "@rocicorp/zero";
import type { Schema } from "./schema.gen.ts";

type Tx = Transaction<Schema>;
type Row = Record<string, unknown>;
const PAGE = 256;

async function query(
	tx: Tx,
	sql: string,
	args: unknown[] = [],
): Promise<Row[]> {
	if (tx.location !== "server") throw new Error("Server transaction required");
	return Array.from(await tx.dbTransaction.query(sql, args));
}

function id(row: Row | undefined, key = "id"): string {
	const value = row?.[key];
	if (typeof value !== "string")
		throw new Error("Membership authority changed");
	return value;
}

function principalId(row: Row | undefined, key: string): string {
	const value = id(row, key);
	if (!value) throw new Error("Membership authority changed");
	return value;
}

async function context(tx: Tx, actorId: string): Promise<void> {
	const rows = await query(
		tx,
		"select current_setting('ditero.user_id',true) as actor, current_setting('ditero.activation_scope',true) as scope",
	);
	if (rows.length !== 1 || (rows[0].scope ?? "") !== "")
		throw new Error("Membership context changed");
	if (rows[0].actor && rows[0].actor !== actorId)
		throw new Error("Membership context changed");
	if (!rows[0].actor) {
		const set = await query(
			tx,
			"select set_config('ditero.user_id',$1,true) as actor",
			[actorId],
		);
		if (set.length !== 1 || set[0].actor !== actorId)
			throw new Error("Membership context changed");
	}
	const verify = await query(
		tx,
		"select current_setting('ditero.user_id',true) as actor",
	);
	if (verify.length !== 1 || verify[0].actor !== actorId)
		throw new Error("Membership context changed");
}

type Authority = {
	workspaceId: string;
	targetUserId: string;
	callerRole: string;
	replacementUserId: string | null;
};

// Discovery is advisory. The same authorization is checked after the ordered
// locks; any changed authority aborts instead of adding an earlier lock late.
async function lockAuthority(
	tx: Tx,
	actorId: string,
	membershipId: string,
	remove: boolean,
): Promise<Authority> {
	await context(tx, actorId);
	const discovered = await query(
		tx,
		`select m.user_id, m.workspace_id, m.role, w.owner_id, w.kind
		from membership m join workspace w on w.id=m.workspace_id where m.id=$1`,
		[membershipId],
	);
	if (discovered.length !== 1) throw new Error("membership not found");
	const targetUserId = principalId(discovered[0], "user_id");
	const workspaceId = principalId(discovered[0], "workspace_id");
	const ownerRows = await query(
		tx,
		`select m.user_id from membership m join "user" u on u.id=m.user_id
		where m.workspace_id=$1 and m.role='owner' and m.user_id<>$2 and u.deleted_at is null
		order by m.user_id limit 1`,
		[workspaceId, targetUserId],
	);
	const replacementUserId = ownerRows.length
		? principalId(ownerRows[0], "user_id")
		: null;
	for (const userId of [
		...new Set([
			actorId,
			targetUserId,
			...(replacementUserId ? [replacementUserId] : []),
		]),
	].sort()) {
		const rows = await query(
			tx,
			'select id,deleted_at from "user" where id=$1 for update',
			[userId],
		);
		if (
			rows.length !== 1 ||
			rows[0].id !== userId ||
			rows[0].deleted_at !== null
		)
			throw new Error("Membership user authority changed");
	}
	const workspace = await query(
		tx,
		"select id,owner_id,kind from workspace where id=$1 for update",
		[workspaceId],
	);
	if (workspace.length !== 1 || workspace[0].id !== workspaceId)
		throw new Error("Workspace changed");
	const lockedMembers = await query(
		tx,
		`select id,user_id,role from membership where workspace_id=$1
		and user_id = any($2::text[]) order by id for update`,
		[
			workspaceId,
			[
				...new Set([
					actorId,
					targetUserId,
					...(replacementUserId ? [replacementUserId] : []),
				]),
			],
		],
	);
	const target = lockedMembers.find((row) => row.id === membershipId);
	const caller = lockedMembers.find((row) => row.user_id === actorId);
	const replacement = lockedMembers.find(
		(row) => row.user_id === replacementUserId,
	);
	if (
		!target ||
		target.user_id !== targetUserId ||
		workspace[0].owner_id !== discovered[0].owner_id ||
		workspace[0].kind !== discovered[0].kind
	)
		throw new Error("Membership authority changed");
	const lockedOwners = await query(
		tx,
		`select m.user_id from membership m join "user" u on u.id=m.user_id
		where m.workspace_id=$1 and m.role='owner' and m.user_id<>$2 and u.deleted_at is null
		order by m.user_id limit 1`,
		[workspaceId, targetUserId],
	);
	if (
		(lockedOwners.length ? principalId(lockedOwners[0], "user_id") : null) !==
			replacementUserId ||
		(replacementUserId && replacement?.role !== "owner")
	)
		throw new Error("Membership authority changed");
	const personal = workspace[0].kind === "personal";
	if (
		personal &&
		!(remove && workspace[0].owner_id === actorId && targetUserId !== actorId)
	)
		throw new Error("personal workspace membership is fixed");
	if (
		!personal &&
		(!caller || !["owner", "admin"].includes(String(caller.role)))
	)
		throw new Error("access denied: need admin+");
	const callerRole = personal ? "owner" : String(caller?.role);
	if (target.role === "owner" && callerRole !== "owner")
		throw new Error("access denied: only an owner may change an owner");
	if (target.role === "owner" && !replacementUserId)
		throw new Error(
			remove ? "cannot remove the last owner" : "cannot demote the last owner",
		);
	if (targetUserId === actorId)
		throw new Error("access denied: cannot change your own membership");
	if (remove && workspace[0].owner_id === targetUserId && !replacementUserId)
		throw new Error("cannot remove the last owner");
	return { workspaceId, targetUserId, callerRole, replacementUserId };
}

export async function lockMembershipRoleChange(
	tx: Tx,
	actorId: string,
	membershipId: string,
): Promise<string> {
	return (await lockAuthority(tx, actorId, membershipId, false)).callerRole;
}

const affected = `
	select t.id from task t join list l on l.id=t.list_id
	left join task_notification_activation g on g.task_id=t.id
	where l.workspace_id=$1 and ($3::text is null or t.id>$3) and (
		l.owner_id=$2 or t.fallback_user_id=$2
		or exists (select 1 from task_assignee a where a.task_id=t.id and a.user_id=$2)
		or (g.status in ('pending','blocked') and (
			g.owning_owner_user_id=$2
			or g.expected_relationships->'assignees' @> jsonb_build_array(jsonb_build_object('userId',$2::text))
			or g.expected_relationships->'ownerFallback'->>'userId'=$2
			or g.expected_relationships->'escalationFallback'->>'userId'=$2
		))
	) order by t.id limit ${PAGE}`;

async function lockPaged(
	tx: Tx,
	sql: string,
	args: unknown[],
	cursorKey = "id",
): Promise<void> {
	let cursor: string | null = null;
	while (true) {
		const rows = await query(tx, sql, [...args, cursor]);
		if (rows.length === 0) break;
		cursor = id(rows[rows.length - 1], cursorKey);
	}
}

// Caller owns the transaction and must roll it back on every rejection.
export async function removeMembershipWithActivation(
	tx: Tx,
	actorId: string,
	membershipId: string,
): Promise<void> {
	const authority = await lockAuthority(tx, actorId, membershipId, true);
	const { workspaceId, targetUserId, replacementUserId } = authority;
	await lockPaged(
		tx,
		`select id from list where workspace_id=$1 and ($2::text is null or id>$2) order by id limit ${PAGE} for update`,
		[workspaceId],
	);
	await query(
		tx,
		"create temporary table if not exists membership_activation_affected (id text primary key) on commit drop",
	);
	await query(tx, "truncate membership_activation_affected");
	let cursor: string | null = null;
	while (true) {
		const rows = await query(tx, `${affected} for update of t`, [
			workspaceId,
			targetUserId,
			cursor,
		]);
		if (rows.length === 0) break;
		const taskIds = rows.map((row) => id(row));
		await query(
			tx,
			"insert into membership_activation_affected(id) select unnest($1::text[]) on conflict do nothing",
			[taskIds],
		);
		cursor = taskIds[taskIds.length - 1];
	}
	const changed = await query(
		tx,
		`select (select count(*) from membership_activation_affected)::text as locked,
		(select count(*) from (${affected.replace(`limit ${PAGE}`, "")}) current)::text as current`,
		[workspaceId, targetUserId, null],
	);
	if (changed.length !== 1 || changed[0].locked !== changed[0].current)
		throw new Error("Membership affected tasks changed");
	let pairTask: string | null = null;
	let pairUser: string | null = null;
	while (true) {
		const rows = await query(
			tx,
			`select a.task_id,a.user_id from task_assignee a join membership_activation_affected e on e.id=a.task_id
			where a.user_id=$1 and ($2::text is null or (a.task_id,a.user_id)>($2,$3))
			order by a.task_id,a.user_id limit ${PAGE} for update of a`,
			[targetUserId, pairTask, pairUser],
		);
		if (!rows.length) break;
		pairTask = id(rows[rows.length - 1], "task_id");
		pairUser = id(rows[rows.length - 1], "user_id");
	}
	await lockPaged(
		tx,
		`select g.task_id as id from task_notification_activation g join membership_activation_affected e on e.id=g.task_id
		where ($1::text is null or g.task_id>$1) order by g.task_id limit ${PAGE} for update of g`,
		[],
	);
	let recipientTask: string | null = null;
	let recipientUser: string | null = null;
	while (true) {
		const rows = await query(
			tx,
			`select r.task_id,r.user_id from task_notification_recipient r
			join membership_activation_affected e on e.id=r.task_id
			where ($1::text is null or (r.task_id,r.user_id) > ($1,$2))
			order by r.task_id,r.user_id limit ${PAGE} for update of r`,
			[recipientTask, recipientUser],
		);
		if (!rows.length) break;
		recipientTask = id(rows[rows.length - 1], "task_id");
		recipientUser = id(rows[rows.length - 1], "user_id");
	}
	await query(
		tx,
		`update task_notification_activation g set status='blocked',completion_mode=null,
		blocked_reason='membership-removed',updated_at=now()
		from membership_activation_affected e where e.id=g.task_id`,
	);
	await query(
		tx,
		`update task_notification_recipient r set active=false
		from membership_activation_affected e where e.id=r.task_id`,
	);
	await query(
		tx,
		`delete from task_assignee a using task t,list l
		where a.task_id=t.id and t.list_id=l.id and l.workspace_id=$1 and a.user_id=$2`,
		[workspaceId, targetUserId],
	);
	await query(
		tx,
		`update task t set fallback_user_id=null from list l
		where t.list_id=l.id and l.workspace_id=$1 and t.fallback_user_id=$2`,
		[workspaceId, targetUserId],
	);
	if (replacementUserId) {
		await query(
			tx,
			"update list set owner_id=$1 where workspace_id=$2 and owner_id=$3",
			[replacementUserId, workspaceId, targetUserId],
		);
		await query(
			tx,
			"update workspace set owner_id=$1 where id=$2 and owner_id=$3",
			[replacementUserId, workspaceId, targetUserId],
		);
	}
	await query(tx, "update workspace set rotation_required=true where id=$1", [
		workspaceId,
	]);
	const removed = await query(
		tx,
		"delete from membership where id=$1 returning id",
		[membershipId],
	);
	if (removed.length !== 1 || removed[0].id !== membershipId)
		throw new Error("Membership authority changed");
}
