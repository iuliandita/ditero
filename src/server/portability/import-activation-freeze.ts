import type { PoolClient } from "pg";
import type { ImportApplyCandidate } from "../../domain/portability/import-apply.ts";
import {
	digestImportExpectedRelationships,
	type ImportRelationshipEvidence,
	type ImportTargetSnapshot,
} from "../../domain/portability/import-apply-plan.ts";
import {
	type ImportMappings,
	ImportPlanError,
} from "../../domain/portability/import-plan.ts";
import type { PortableExportV1 } from "../../domain/portability/v1.ts";

const MAX_ROWS = 50_000;
const MAX_BYTES = 64 * 1024 * 1024;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (userId: string, workspaceId: string) =>
	JSON.stringify([userId, workspaceId]);

export class ImportActivationLimitError extends Error {
	readonly code = "import-target-limit";
	readonly status = 413;
	constructor() {
		super("Import activation evidence exceeds the planning limit");
	}
}

type Seat = { userId: string; workspaceId: string; membershipId: string };
export type V4Authority = {
	userIds: string[];
	workspaceIds: string[];
	pairs: { userId: string; workspaceId: string }[];
	seats: Map<string, Seat>;
};
type PlanningOptions = { signal?: AbortSignal; deadline?: number };
function checkpoint(options: PlanningOptions) {
	if (options.signal?.aborted) throw new ImportPlanError("planning-cancelled");
	if (options.deadline !== undefined && performance.now() >= options.deadline)
		throw new ImportPlanError("planning-timeout");
}

function projectedTaskIds(items: readonly ImportApplyCandidate[]): string[] {
	return [
		...new Set(
			items
				.filter(
					(item) =>
						item.collection === "tasks" && item.disposition === "ensure",
				)
				.map((item) => item.targetId)
				.filter((id): id is string => id !== null),
		),
	].sort(compare);
}

// This read happens after BEGIN and user scope setup, before any user row lock.
// The later task-locked read must be a subset of these discovered user IDs.
export async function discoverV4Authority(
	client: PoolClient,
	ownerId: string,
	document: PortableExportV1,
	mappings: ImportMappings,
	items: readonly ImportApplyCandidate[],
	options: PlanningOptions = {},
): Promise<V4Authority> {
	checkpoint(options);
	const ids = projectedTaskIds(items);
	let discoveredRows = 0;
	let discoveredBytes = 0;
	const workspaceIds = new Set(Object.values(mappings.workspaces));
	const userIds = new Set<string>([ownerId]);
	const pairs = new Map<string, { userId: string; workspaceId: string }>();
	function add(
		userId: string | null | undefined,
		workspaceId: string | null | undefined,
	) {
		if (!userId || !workspaceId) return;
		userIds.add(userId);
		workspaceIds.add(workspaceId);
		pairs.set(pairKey(userId, workspaceId), { userId, workspaceId });
		if (pairs.size > MAX_ROWS) throw new ImportActivationLimitError();
	}
	for (const value of Object.values(mappings.principals))
		if (value) userIds.add(value);
	const sourceLists = new Map(document.data.lists.map((row) => [row.id, row]));
	const sourceTasks = new Map(document.data.tasks.map((row) => [row.id, row]));
	const sourceWorkspace = (taskId: string) => {
		const task = sourceTasks.get(taskId);
		return task ? sourceLists.get(task.listId)?.workspaceId : undefined;
	};
	for (const row of document.data.workspaces)
		add(mappings.principals[row.ownerId], mappings.workspaces[row.id]);
	for (const row of document.data.memberships)
		add(mappings.principals[row.userId], mappings.workspaces[row.workspaceId]);
	for (const row of document.data.lists)
		add(mappings.principals[row.ownerId], mappings.workspaces[row.workspaceId]);
	for (const row of document.data.templates)
		add(
			mappings.principals[row.createdBy],
			mappings.workspaces[row.workspaceId],
		);
	for (const row of document.data.tasks)
		add(
			mappings.principals[row.fallbackUserId ?? ""],
			mappings.workspaces[sourceWorkspace(row.id) ?? ""],
		);
	for (const row of document.data.assignments)
		add(
			mappings.principals[row.userId],
			mappings.workspaces[sourceWorkspace(row.taskId) ?? ""],
		);
	for (const row of document.data.comments)
		add(
			mappings.principals[row.authorId],
			mappings.workspaces[sourceWorkspace(row.taskId) ?? ""],
		);
	for (const row of document.data.attachments)
		add(
			mappings.principals[row.uploadedBy],
			mappings.workspaces[row.workspaceId],
		);
	for (const row of [...document.data.views, ...document.data.dashboards])
		add(
			mappings.principals[row.ownerId],
			mappings.workspaces[row.workspaceId ?? ""],
		);
	for (const workspaceId of workspaceIds) add(ownerId, workspaceId);
	for (let offset = 0; offset < ids.length; offset += 256) {
		checkpoint(options);
		const batch = ids.slice(offset, offset + 256);
		const count = await client.query<{ count: string; bytes: string }>(
			`select count(*)::text as count, coalesce(sum(octet_length(a.user_id)), 0)::text as bytes from task_assignee a where a.task_id = any($1::text[])`,
			[batch],
		);
		discoveredRows += Number(count.rows[0]?.count);
		discoveredBytes += Number(count.rows[0]?.bytes);
		if (
			!Number.isSafeInteger(discoveredRows) ||
			!Number.isSafeInteger(discoveredBytes) ||
			discoveredRows > MAX_ROWS ||
			discoveredBytes > MAX_BYTES
		)
			throw new ImportActivationLimitError();
		const tasks = await client.query<{
			workspace_id: string;
			owner_id: string;
			fallback_user_id: string | null;
		}>(
			`select l.workspace_id, l.owner_id, t.fallback_user_id from task t join list l on l.id = t.list_id where t.id = any($1::text[]) order by t.id`,
			[batch],
		);
		for (const task of tasks.rows) {
			add(task.owner_id, task.workspace_id);
			add(task.fallback_user_id, task.workspace_id);
		}
		const assignees = await client.query<{
			user_id: string;
			workspace_id: string;
		}>(
			`select a.user_id, l.workspace_id from task_assignee a join task t on t.id = a.task_id join list l on l.id = t.list_id where a.task_id = any($1::text[]) order by a.id`,
			[batch],
		);
		for (const row of assignees.rows) add(row.user_id, row.workspace_id);
	}
	if (userIds.size > MAX_ROWS || workspaceIds.size > MAX_ROWS)
		throw new ImportActivationLimitError();
	return {
		userIds: [...userIds].sort(compare),
		workspaceIds: [...workspaceIds].sort(compare),
		pairs: [...pairs.values()].sort((a, b) =>
			compare(
				pairKey(a.userId, a.workspaceId),
				pairKey(b.userId, b.workspaceId),
			),
		),
		seats: new Map(),
	};
}

export async function lockV4Authority(
	client: PoolClient,
	authority: V4Authority,
) {
	for (let offset = 0; offset < authority.workspaceIds.length; offset += 256) {
		const ids = authority.workspaceIds.slice(offset, offset + 256);
		await client.query(
			`select id from workspace where id = any($1::text[]) order by id for share`,
			[ids],
		);
	}
	const ids = new Set<string>();
	for (let offset = 0; offset < authority.pairs.length; offset += 256) {
		const requested = authority.pairs.slice(offset, offset + 256);
		const found = await client.query<{
			id: string;
			user_id: string;
			workspace_id: string;
		}>(
			`select m.id, m.user_id, m.workspace_id from membership m where exists (select 1 from jsonb_to_recordset($1::jsonb) as p("userId" text, "workspaceId" text) where p."userId" = m.user_id and p."workspaceId" = m.workspace_id) order by m.id`,
			[JSON.stringify(requested)],
		);
		for (const row of found.rows) {
			ids.add(row.id);
			authority.seats.set(pairKey(row.user_id, row.workspace_id), {
				userId: row.user_id,
				workspaceId: row.workspace_id,
				membershipId: row.id,
			});
		}
	}
	const sorted = [...ids].sort(compare);
	for (let offset = 0; offset < sorted.length; offset += 256) {
		const batch = sorted.slice(offset, offset + 256);
		const locked = await client.query<{
			id: string;
			user_id: string;
			workspace_id: string;
		}>(
			`select id, user_id, workspace_id from membership where id = any($1::text[]) order by id for share`,
			[batch],
		);
		if (
			locked.rows.length !== batch.length ||
			locked.rows.some(
				(row) =>
					authority.seats.get(pairKey(row.user_id, row.workspace_id))
						?.membershipId !== row.id,
			)
		)
			throw new ImportPlanError("invalid-mappings");
	}
}

type GuardRow = {
	task_id: string;
	status: "pending" | "active" | "blocked";
	generation: number;
	owning_source_id: string | null;
	owning_owner_user_id: string | null;
	owning_job_id: string | null;
	expected_relationship_digest: string | null;
};
type LivePair = { task_id: string; user_id: string };

export async function freezeV4Activation(
	client: PoolClient,
	ownerId: string,
	document: PortableExportV1,
	mappings: ImportMappings,
	items: ImportApplyCandidate[],
	snapshots: Map<string, ImportTargetSnapshot>,
	targets: Map<string, Map<string, Record<string, unknown>>>,
	authority: V4Authority,
	usedRows: number,
	usedBytes: number,
	options: PlanningOptions = {},
): Promise<void> {
	const taskItems = items.filter(
		(item) => item.collection === "tasks" && item.disposition === "ensure",
	);
	const ids = projectedTaskIds(taskItems);
	const allowedUsers = new Set(authority.userIds);
	const livePairs = new Map<string, Set<string>>();
	const lockedPairs = new Set(
		[...(targets.get("assignments")?.values() ?? [])].map((row) =>
			pairKey(String(row.user_id), String(row.task_id)),
		),
	);
	const guards = new Map<string, GuardRow>();
	let relationshipRows = 0;
	let relationshipBytes = 0;
	for (let offset = 0; offset < ids.length; offset += 256) {
		checkpoint(options);
		const batch = ids.slice(offset, offset + 256);
		const probe = await client.query<{ count: string; bytes: string }>(
			`select count(*)::text as count, coalesce(sum(octet_length(a.user_id)), 0)::text as bytes from task_assignee a where a.task_id = any($1::text[])`,
			[batch],
		);
		relationshipRows += Number(probe.rows[0]?.count);
		relationshipBytes += Number(probe.rows[0]?.bytes);
		if (
			!Number.isSafeInteger(relationshipRows) ||
			!Number.isSafeInteger(relationshipBytes) ||
			relationshipRows > MAX_ROWS ||
			relationshipBytes > MAX_BYTES
		)
			throw new ImportActivationLimitError();
		const pairs = await client.query<LivePair>(
			`select task_id, user_id from task_assignee where task_id = any($1::text[]) order by id`,
			[batch],
		);
		for (const pair of pairs.rows) {
			if (!allowedUsers.has(pair.user_id))
				throw new ImportPlanError("invalid-mappings");
			if (!lockedPairs.has(pairKey(pair.user_id, pair.task_id)))
				throw new ImportPlanError("invalid-mappings");
			const set = livePairs.get(pair.task_id) ?? new Set<string>();
			set.add(pair.user_id);
			livePairs.set(pair.task_id, set);
		}
		const found = await client.query<GuardRow>(
			`select task_id, status, generation, owning_source_id, owning_owner_user_id, owning_job_id, expected_relationship_digest from task_notification_activation where task_id = any($1::text[]) order by task_id for share`,
			[batch],
		);
		for (const row of found.rows) guards.set(row.task_id, row);
	}
	const sourceLists = new Map(document.data.lists.map((row) => [row.id, row]));
	const sourceTasks = new Map(document.data.tasks.map((row) => [row.id, row]));
	const sourceAssignmentTasks = new Map(
		document.data.assignments.map((row) => [row.id, row.taskId]),
	);
	const byTask = new Map<string, ImportApplyCandidate[]>();
	for (const item of items) {
		if (item.collection !== "assignments" || item.disposition !== "ensure")
			continue;
		const sourceTaskId = sourceAssignmentTasks.get(item.sourceId);
		if (sourceTaskId === undefined) throw new ImportPlanError("invalid-graph");
		const list = byTask.get(sourceTaskId) ?? [];
		list.push(item);
		byTask.set(sourceTaskId, list);
	}
	let totalCount = usedRows;
	let totalBytes = usedBytes;
	for (const task of taskItems) {
		checkpoint(options);
		if (!task.targetId) throw new ImportPlanError("invalid-mappings");
		const snapshot = snapshots.get(task.sourceKey);
		if (!snapshot) throw new ImportPlanError("invalid-mappings");
		const source = sourceTasks.get(task.sourceId);
		const sourceList = source && sourceLists.get(source.listId);
		if (
			!source ||
			!sourceList ||
			!task.payload ||
			typeof task.payload !== "object" ||
			Array.isArray(task.payload)
		)
			throw new ImportPlanError("invalid-graph");
		const workspaceId = mappings.workspaces[sourceList.workspaceId];
		const listId = task.payload.listId;
		if (!workspaceId || typeof listId !== "string")
			throw new ImportPlanError("invalid-mappings");
		const currentList = targets.get("lists")?.get(listId);
		const listOwnerId = currentList
			? currentList.owner_id
			: mappings.principals[sourceList.ownerId];
		if (typeof listOwnerId !== "string")
			throw new ImportPlanError("invalid-mappings");
		if (!allowedUsers.has(listOwnerId))
			throw new ImportPlanError("invalid-mappings");
		const fallbackId = task.payload.fallbackUserId;
		if (fallbackId !== null && fallbackId !== undefined) {
			if (typeof fallbackId !== "string")
				throw new ImportPlanError("invalid-mappings");
			const seat = authority.seats.get(pairKey(fallbackId, workspaceId));
			if (!seat || !allowedUsers.has(fallbackId)) {
				task.disposition = "blocked";
				task.codes.push("invalid-fallback-membership");
				continue;
			}
			snapshot.dependencyProof.fallback = {
				sourceUserId: source.fallbackUserId ?? "",
				targetUserId: fallbackId,
				workspaceId,
				membershipId: seat.membershipId,
			};
		}
		const sourceAssignments = byTask.get(task.sourceId) ?? [];
		const users = new Set(livePairs.get(task.targetId) ?? []);
		let newLinks = false;
		for (const assignment of sourceAssignments) {
			const payload = assignment.payload;
			if (
				!payload ||
				typeof payload !== "object" ||
				Array.isArray(payload) ||
				typeof payload.userId !== "string"
			)
				throw new ImportPlanError("invalid-graph");
			users.add(payload.userId);
			if (
				snapshots.get(assignment.sourceKey)?.targetPrecondition.kind ===
				"absent"
			)
				newLinks = true;
		}
		const existing = guards.get(task.targetId);
		if (existing?.status === "blocked") {
			task.disposition = "blocked";
			task.codes.push("activation-blocked");
			continue;
		}
		if (existing?.status === "pending") {
			if (existing.owning_owner_user_id !== ownerId) {
				task.disposition = "blocked";
				task.codes.push("activation-running");
				continue;
			}
			const prior = await client.query<{
				state: string | null;
				job_id: string | null;
			}>(
				`select r.state, j.id as job_id from import_job j left join import_run r on r.job_id = j.id and r.owner_user_id = $2 where j.id = $1 and j.owner_user_id = $2`,
				[existing.owning_job_id, ownerId],
			);
			if (
				prior.rows[0] &&
				!["completed", "conflict"].includes(prior.rows[0].state ?? "")
			) {
				task.disposition = "blocked";
				task.codes.push("activation-running");
				continue;
			}
		}
		const activationNeeded =
			snapshot.targetPrecondition.kind === "absent" || newLinks || !!existing;
		if (!activationNeeded) continue;
		const assignees: ImportRelationshipEvidence["assignees"] = [];
		for (const userId of [...users].sort(compare)) {
			if (!allowedUsers.has(userId))
				throw new ImportPlanError("invalid-mappings");
			const seat = authority.seats.get(pairKey(userId, workspaceId));
			if (!seat) {
				task.disposition = "blocked";
				task.codes.push("invalid-assignee-membership");
				break;
			}
			assignees.push({ userId, membershipId: seat.membershipId });
		}
		if (task.disposition !== "ensure") continue;
		const ownerSeat =
			users.size === 0
				? authority.seats.get(pairKey(listOwnerId, workspaceId))
				: null;
		if (users.size === 0 && !ownerSeat) {
			task.disposition = "blocked";
			task.codes.push("invalid-owner-membership");
			continue;
		}
		const fallbackSeat =
			typeof fallbackId === "string"
				? authority.seats.get(pairKey(fallbackId, workspaceId))
				: null;
		const evidence: ImportRelationshipEvidence = {
			version: 1,
			workspaceId,
			assignees,
			ownerFallback: ownerSeat
				? { userId: ownerSeat.userId, membershipId: ownerSeat.membershipId }
				: null,
			escalationFallback: fallbackSeat
				? {
						userId: fallbackSeat.userId,
						membershipId: fallbackSeat.membershipId,
					}
				: null,
		};
		const count =
			assignees.length + Number(!!ownerSeat) + Number(!!fallbackSeat);
		const size = await client.query<{ bytes: number }>(
			`select octet_length($1::jsonb::text)::int as bytes`,
			[JSON.stringify(evidence)],
		);
		const bytes = size.rows[0]?.bytes;
		if (!Number.isSafeInteger(bytes) || !bytes)
			throw new ImportPlanError("invalid-mappings");
		totalCount += count;
		totalBytes += bytes;
		if (totalCount > MAX_ROWS || totalBytes > MAX_BYTES)
			throw new ImportActivationLimitError();
		const transition =
			snapshot.targetPrecondition.kind === "absent" ||
			newLinks ||
			existing?.status === "pending";
		const generation = existing ? existing.generation + Number(transition) : 1;
		let readinessOrdinal = task.ordinal;
		if (transition)
			for (const assignment of sourceAssignments)
				readinessOrdinal = Math.max(readinessOrdinal, assignment.ordinal);
		snapshot.dependencyProof.activation = {
			kind: transition ? "transition" : "observe",
			precondition: existing
				? {
						kind: "present",
						status: existing.status as "pending" | "active",
						generation: existing.generation,
						owningSourceId: existing.owning_source_id,
						owningJobId: existing.owning_job_id,
						owningOwnerUserId: existing.owning_owner_user_id,
						expectedRelationshipDigest:
							existing.expected_relationship_digest ?? "",
					}
				: { kind: "absent" },
			generation,
			readinessOrdinal,
			expectedRelationships: {
				digest: await digestImportExpectedRelationships(evidence, () =>
					checkpoint(options),
				),
				count,
				bytes,
				evidence,
			},
		};
		for (const assignment of sourceAssignments) {
			const assignmentSnapshot = snapshots.get(assignment.sourceKey);
			if (!assignmentSnapshot) throw new ImportPlanError("invalid-mappings");
			assignmentSnapshot.dependencyProof.taskActivationGeneration = generation;
		}
	}
}
