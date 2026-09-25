import type { PoolClient } from "pg";
import {
	digestImportExpectedRelationships,
	type FrozenImportItem,
	type ImportRelationshipEvidence,
	type ImportTaskActivationProof,
} from "../../domain/portability/import-apply-plan.ts";
import { digestImportTarget, IMPORT_TARGETS } from "./import-target.ts";

const MAX_ROWS = 50_000;
const MAX_BYTES = 64 * 1024 * 1024;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (taskId: string, userId: string) =>
	JSON.stringify([taskId, userId]);

export class V4ApplyConflict extends Error {
	constructor(
		readonly code: string,
		readonly ordinal: number,
	) {
		super(code);
	}
}

type Seat = { id: string; user_id: string; workspace_id: string; role: string };
type CurrentTask = {
	id: string;
	list_id: string;
	parent_id: string | null;
	workspace_id: string;
	owner_id: string;
	fallback_user_id: string | null;
};
type Pair = { id: string; task_id: string; user_id: string };
type Guard = {
	task_id: string;
	status: "pending" | "blocked" | "active";
	generation: number;
	import_occurrence_cutoff: Date | null;
	recipient_generation_cutoff: Date | null;
	owning_source_id: string | null;
	owning_owner_user_id: string | null;
	owning_job_id: string | null;
	readiness_ordinal: number;
	expected_relationship_digest: string | null;
	expected_relationship_count: number | null;
	expected_relationship_bytes: number | null;
	expected_relationships: ImportRelationshipEvidence | null;
};
type Recipient = {
	task_id: string;
	user_id: string;
	active: boolean;
	generation: number;
	cutoff: Date | null;
	overdue_suppressed_due_at: Date | null;
};
type ReadyItem = Pick<
	FrozenImportItem,
	"ordinal" | "collection" | "targetId" | "dependencyProof" | "payload"
>;

const readyColumns = `ordinal, collection, source_id as "sourceId", source_key as "sourceKey",
	item_digest as "itemDigest", target_id as "targetId", disposition, payload, codes,
	phase, content_digest as "contentDigest", target_precondition as "targetPrecondition",
	dependency_proof as "dependencyProof"`;

export type V4ApplyAuthority = {
	start: number;
	next: number;
	userIds: Set<string>;
	workspaceIds: string[];
	membershipIds: string[];
	taskIds: string[];
	listIds: string[];
	parentIds: string[];
	pairIds: string[];
	ready: FrozenImportItem[];
	currentTasks: Map<string, CurrentTask>;
	currentPairs: Map<string, Pair>;
	usedRows: number;
	usedBytes: number;
};

function bounded(value: number, ordinal: number): void {
	if (!Number.isSafeInteger(value) || value > MAX_ROWS)
		throw new V4ApplyConflict("import-target-limit", ordinal);
}

function boundedBytes(value: number, ordinal: number): void {
	if (!Number.isSafeInteger(value) || value > MAX_BYTES)
		throw new V4ApplyConflict("import-batch-too-large", ordinal);
}

function proofOf(item: ReadyItem): ImportTaskActivationProof | undefined {
	return item.dependencyProof?.activation;
}

function expectedTaskRow(item: ReadyItem): Record<string, unknown> {
	const payload = item.payload;
	if (!payload || typeof payload !== "object" || Array.isArray(payload))
		throw new V4ApplyConflict("invalid-plan-evidence", item.ordinal);
	const result: Record<string, unknown> = {};
	for (const field of IMPORT_TARGETS.tasks.fields) {
		const column = field.replace(
			/[A-Z]/g,
			(letter) => `_${letter.toLowerCase()}`,
		);
		const value = payload[field];
		result[column] =
			(field === "dueAt" || field === "completedAt") &&
			typeof value === "string"
				? new Date(value)
				: value;
	}
	return result;
}

async function readyItems(
	client: PoolClient,
	jobId: string,
	start: number,
	next: number,
): Promise<{ rows: FrozenImportItem[]; bytes: number }> {
	if (next === start) return { rows: [], bytes: 0 };
	const condition = `job_id = $1 and collection = 'tasks' and disposition = 'ensure'
		and dependency_proof->'activation'->>'kind' = 'transition'
		and ordinal < $2
		and (dependency_proof->'activation'->>'readinessOrdinal')::integer >= $2
		and (dependency_proof->'activation'->>'readinessOrdinal')::integer < $3`;
	const probe = await client.query<{ count: string; bytes: string }>(
		`select count(*)::text as count, coalesce(sum(octet_length(i::text)), 0)::text as bytes from import_item i where ${condition}`,
		[jobId, start, next],
	);
	bounded(Number(probe.rows[0]?.count), start);
	boundedBytes(Number(probe.rows[0]?.bytes), start);
	if (Number(probe.rows[0]?.count) > 100)
		throw new V4ApplyConflict("activation-readiness-limit", start);
	const rows = (
		await client.query<FrozenImportItem>(
			`select ${readyColumns} from import_item i where ${condition} order by ordinal limit 101`,
			[jobId, start, next],
		)
	).rows;
	return { rows, bytes: Number(probe.rows[0]?.bytes) };
}

// Runs after BEGIN and owner scope setup, before any user row lock.
export async function discoverV4ApplyAuthority(
	client: PoolClient,
	ownerId: string,
	jobId: string,
): Promise<V4ApplyAuthority> {
	const run = await client.query<{ next_ordinal: number }>(
		"select next_ordinal from import_run where job_id = $1 and owner_user_id = $2",
		[jobId, ownerId],
	);
	const start = run.rows[0]?.next_ordinal ?? 0;
	const probe = await client.query<{ bytes: string }>(
		"select coalesce(sum(octet_length(i::text)),0)::text as bytes from (select * from import_item where job_id = $1 and ordinal >= $2 order by ordinal limit 100) i",
		[jobId, start],
	);
	const windowBytes = Number(probe.rows[0]?.bytes);
	boundedBytes(windowBytes, start);
	const items = (
		await client.query<FrozenImportItem>(
			'select ordinal, collection, target_id as "targetId", disposition, dependency_proof as "dependencyProof", payload from import_item where job_id = $1 and ordinal >= $2 order by ordinal limit 100',
			[jobId, start],
		)
	).rows;
	const next = start + items.length;
	const earlier = await readyItems(client, jobId, start, next);
	let usedRows = items.length + earlier.rows.length;
	let usedBytes = windowBytes + earlier.bytes;
	bounded(usedRows, start);
	boundedBytes(usedBytes, start);
	const ready = [
		...earlier.rows,
		...items.filter(
			(item) =>
				item.collection === "tasks" &&
				item.disposition === "ensure" &&
				item.dependencyProof?.activation?.kind === "transition" &&
				item.dependencyProof.activation.readinessOrdinal < next,
		),
	];
	if (ready.length > 100)
		throw new V4ApplyConflict("activation-readiness-limit", start);
	const userIds = new Set([ownerId]);
	const workspaceIds = new Set<string>();
	const membershipIds = new Set<string>();
	const taskIds = new Set<string>();
	const listIds = new Set<string>();
	const seatPairs = new Map<string, { userId: string; workspaceId: string }>();
	const addSeat = (
		userId: string,
		workspaceId: string,
		membershipId?: string,
	) => {
		userIds.add(userId);
		workspaceIds.add(workspaceId);
		seatPairs.set(JSON.stringify([userId, workspaceId]), {
			userId,
			workspaceId,
		});
		if (membershipId) membershipIds.add(membershipId);
	};
	for (const item of [...items, ...ready]) {
		const proof = item.dependencyProof;
		if (!proof) continue;
		workspaceIds.add(proof.workspace.targetId);
		if (item.collection === "tasks" && item.targetId)
			taskIds.add(item.targetId);
		for (const row of proof.rows) {
			if (row.collection === "tasks") taskIds.add(row.id);
			if (row.collection === "lists") listIds.add(row.id);
		}
		if (proof.assignee)
			addSeat(
				proof.assignee.targetUserId,
				proof.assignee.workspaceId,
				proof.assignee.membershipId,
			);
		if (proof.fallback)
			addSeat(
				proof.fallback.targetUserId,
				proof.fallback.workspaceId,
				proof.fallback.membershipId,
			);
		const evidence = proof.activation?.expectedRelationships.evidence;
		if (evidence) {
			workspaceIds.add(evidence.workspaceId);
			for (const seat of evidence.assignees)
				addSeat(seat.userId, evidence.workspaceId, seat.membershipId);
			for (const seat of [evidence.ownerFallback, evidence.escalationFallback])
				if (seat) addSeat(seat.userId, evidence.workspaceId, seat.membershipId);
		}
	}
	bounded(taskIds.size, start);
	const ids = [...taskIds].sort(compare);
	const currentTasks = new Map<string, CurrentTask>();
	const currentPairs = new Map<string, Pair>();
	const parentIds = new Set<string>();
	const pairIds = new Set<string>();
	for (let offset = 0; offset < ids.length; offset += 256) {
		const page = ids.slice(offset, offset + 256);
		const tasks = await client.query<CurrentTask>(
			`select t.id, t.list_id, t.parent_id, l.workspace_id, l.owner_id, t.fallback_user_id
			from task t join list l on l.id = t.list_id where t.id = any($1::text[]) order by t.id`,
			[page],
		);
		for (const task of tasks.rows) {
			currentTasks.set(task.id, task);
			listIds.add(task.list_id);
			if (task.parent_id) parentIds.add(task.parent_id);
			addSeat(task.owner_id, task.workspace_id);
			if (task.fallback_user_id)
				addSeat(task.fallback_user_id, task.workspace_id);
		}
		const count = await client.query<{ count: string; bytes: string }>(
			`select count(*)::text as count, coalesce(sum(octet_length(a::text)),0)::text as bytes
			from task_assignee a where a.task_id = any($1::text[])`,
			[page],
		);
		usedRows += Number(count.rows[0]?.count);
		usedBytes += Number(count.rows[0]?.bytes);
		bounded(usedRows, start);
		boundedBytes(usedBytes, start);
		const pairs = await client.query<Pair>(
			"select id, task_id, user_id from task_assignee where task_id = any($1::text[]) order by id",
			[page],
		);
		for (const pair of pairs.rows) {
			currentPairs.set(pair.id, pair);
			pairIds.add(pair.id);
			const task = currentTasks.get(pair.task_id);
			if (task) addSeat(pair.user_id, task.workspace_id);
		}
		const recipientSize = await client.query<{ count: string; bytes: string }>(
			"select count(*)::text as count,coalesce(sum(octet_length(r::text)),0)::text as bytes from task_notification_recipient r where task_id=any($1::text[]) and active",
			[page],
		);
		usedRows += Number(recipientSize.rows[0]?.count);
		usedBytes += Number(recipientSize.rows[0]?.bytes);
		bounded(usedRows, start);
		boundedBytes(usedBytes, start);
		const recipients = await client.query<{ user_id: string }>(
			"select user_id from task_notification_recipient where task_id = any($1::text[]) and active order by task_id, user_id",
			[page],
		);
		for (const recipient of recipients.rows) userIds.add(recipient.user_id);
	}
	for (const workspaceId of workspaceIds) addSeat(ownerId, workspaceId);
	bounded(userIds.size, start);
	bounded(seatPairs.size, start);
	const seatList = [...seatPairs.values()];
	for (let offset = 0; offset < seatList.length; offset += 256) {
		const rows = await client.query<{ id: string }>(
			`select m.id from membership m where exists (
				select 1 from jsonb_to_recordset($1::jsonb) as p("userId" text, "workspaceId" text)
				where p."userId" = m.user_id and p."workspaceId" = m.workspace_id)
			order by m.id`,
			[JSON.stringify(seatList.slice(offset, offset + 256))],
		);
		for (const row of rows.rows) membershipIds.add(row.id);
	}
	bounded(membershipIds.size, start);
	return {
		start,
		next,
		userIds,
		workspaceIds: [...workspaceIds].sort(compare),
		membershipIds: [...membershipIds].sort(compare),
		taskIds: ids,
		listIds: [...listIds].sort(compare),
		parentIds: [...parentIds].sort(compare),
		pairIds: [...pairIds].sort(compare),
		ready,
		currentTasks,
		currentPairs,
		usedRows,
		usedBytes,
	};
}

export async function lockV4ApplyAuthority(
	client: PoolClient,
	authority: V4ApplyAuthority,
): Promise<Map<string, Seat>> {
	for (let offset = 0; offset < authority.workspaceIds.length; offset += 256) {
		const ids = authority.workspaceIds.slice(offset, offset + 256);
		const found = await client.query<{ id: string }>(
			"select id from workspace where id = any($1::text[]) order by id for share",
			[ids],
		);
		if (found.rows.length !== ids.length)
			throw new V4ApplyConflict("invalid-workspace-mapping", authority.start);
	}
	const seats = new Map<string, Seat>();
	for (let offset = 0; offset < authority.membershipIds.length; offset += 256) {
		const ids = authority.membershipIds.slice(offset, offset + 256);
		const found = await client.query<Seat>(
			"select id, user_id, workspace_id, role from membership where id = any($1::text[]) order by id for share",
			[ids],
		);
		if (found.rows.length !== ids.length)
			throw new V4ApplyConflict(
				"assignee-membership-conflict",
				authority.start,
			);
		for (const seat of found.rows) seats.set(seat.id, seat);
	}
	return seats;
}

export async function assertV4LockedDomain(
	client: PoolClient,
	authority: V4ApplyAuthority,
): Promise<void> {
	let count = 0;
	let bytes = 0;
	const pairs = new Map<string, Pair>();
	for (let offset = 0; offset < authority.taskIds.length; offset += 256) {
		const ids = authority.taskIds.slice(offset, offset + 256);
		const tasks = await client.query<CurrentTask>(
			`select t.id,t.list_id,t.parent_id,l.workspace_id,l.owner_id,t.fallback_user_id
			from task t join list l on l.id=t.list_id where t.id=any($1::text[]) order by t.id`,
			[ids],
		);
		for (const task of tasks.rows) {
			const before = authority.currentTasks.get(task.id);
			if (
				!before ||
				before.list_id !== task.list_id ||
				before.parent_id !== task.parent_id ||
				before.workspace_id !== task.workspace_id ||
				before.owner_id !== task.owner_id ||
				before.fallback_user_id !== task.fallback_user_id
			)
				throw new V4ApplyConflict(
					"activation-target-conflict",
					authority.start,
				);
		}
		if (
			tasks.rows.length !==
			ids.filter((id) => authority.currentTasks.has(id)).length
		)
			throw new V4ApplyConflict("activation-target-conflict", authority.start);
		const size = await client.query<{ count: string; bytes: string }>(
			"select count(*)::text as count,coalesce(sum(octet_length(a::text)),0)::text as bytes from task_assignee a where task_id=any($1::text[])",
			[ids],
		);
		count += Number(size.rows[0]?.count);
		bytes += Number(size.rows[0]?.bytes);
		bounded(count, authority.start);
		boundedBytes(bytes, authority.start);
		const found = await client.query<Pair>(
			"select id,task_id,user_id from task_assignee where task_id=any($1::text[]) order by id",
			[ids],
		);
		for (const pair of found.rows) pairs.set(pair.id, pair);
	}
	if (
		pairs.size !== authority.currentPairs.size ||
		[...pairs].some(([id, pair]) => {
			const before = authority.currentPairs.get(id);
			return (
				!before ||
				before.task_id !== pair.task_id ||
				before.user_id !== pair.user_id
			);
		})
	)
		throw new V4ApplyConflict("activation-pair-conflict", authority.start);
}

export type V4ApplyState = {
	guards: Map<string, Guard>;
	recipients: Map<string, Recipient>;
};

export async function lockV4ActivationRows(
	client: PoolClient,
	authority: V4ApplyAuthority,
): Promise<V4ApplyState> {
	const guards = new Map<string, Guard>();
	const recipients = new Map<string, Recipient>();
	let bytes = authority.usedBytes;
	let rows = authority.usedRows;
	for (let offset = 0; offset < authority.taskIds.length; offset += 256) {
		const ids = authority.taskIds.slice(offset, offset + 256);
		const guardSize = await client.query<{ bytes: string }>(
			"select coalesce(sum(octet_length(expected_relationships::text)),0)::text as bytes from task_notification_activation where task_id = any($1::text[])",
			[ids],
		);
		bytes += Number(guardSize.rows[0]?.bytes);
		boundedBytes(bytes, authority.start);
		const found = await client.query<Guard>(
			`select task_id, status, generation, import_occurrence_cutoff, recipient_generation_cutoff,
			owning_source_id, owning_owner_user_id, owning_job_id, readiness_ordinal,
			expected_relationship_digest, expected_relationship_count, expected_relationship_bytes,
			expected_relationships from task_notification_activation
			where task_id = any($1::text[]) order by task_id for update`,
			[ids],
		);
		rows += found.rows.length;
		bounded(rows, authority.start);
		for (const guard of found.rows) guards.set(guard.task_id, guard);
		const recipientSize = await client.query<{ count: string; bytes: string }>(
			"select count(*)::text as count, coalesce(sum(octet_length(r::text)),0)::text as bytes from task_notification_recipient r where task_id = any($1::text[])",
			[ids],
		);
		rows += Number(recipientSize.rows[0]?.count);
		bounded(rows, authority.start);
		bytes += Number(recipientSize.rows[0]?.bytes);
		boundedBytes(bytes, authority.start);
		const foundRecipients = await client.query<Recipient>(
			`select task_id, user_id, active, generation, cutoff, overdue_suppressed_due_at
			from task_notification_recipient where task_id = any($1::text[])
			order by task_id, user_id for update`,
			[ids],
		);
		for (const recipient of foundRecipients.rows)
			recipients.set(pairKey(recipient.task_id, recipient.user_id), recipient);
	}
	return { guards, recipients };
}

function samePrecondition(
	guard: Guard | undefined,
	proof: ImportTaskActivationProof,
): boolean {
	const pre = proof.precondition;
	if (pre.kind === "absent") return guard === undefined;
	return (
		guard?.status === pre.status &&
		guard.generation === pre.generation &&
		guard.owning_source_id === pre.owningSourceId &&
		guard.owning_job_id === pre.owningJobId &&
		guard.owning_owner_user_id === pre.owningOwnerUserId &&
		guard.expected_relationship_digest === pre.expectedRelationshipDigest
	);
}

export async function stageV4Task(
	client: PoolClient,
	item: FrozenImportItem,
	ownerId: string,
	sourceId: string,
	jobId: string,
	state: V4ApplyState,
): Promise<void> {
	const taskId = item.targetId;
	const proof = item.dependencyProof?.activation;
	if (!taskId) throw new V4ApplyConflict("invalid-plan-evidence", item.ordinal);
	const guard = state.guards.get(taskId);
	if (!proof) {
		if (item.targetPrecondition?.kind !== "mapped" || guard)
			throw new V4ApplyConflict(
				"activation-precondition-conflict",
				item.ordinal,
			);
		return;
	}
	if (!samePrecondition(guard, proof))
		throw new V4ApplyConflict("activation-precondition-conflict", item.ordinal);
	if (proof.kind === "observe") return;
	if (guard?.status === "blocked")
		throw new V4ApplyConflict("activation-blocked", item.ordinal);
	if (guard?.status === "pending") {
		if (
			guard.owning_source_id !== sourceId ||
			guard.owning_owner_user_id !== ownerId ||
			!guard.owning_job_id ||
			guard.owning_job_id === jobId
		)
			throw new V4ApplyConflict("activation-adoption-conflict", item.ordinal);
		const old = await client.query<{ state: string }>(
			"select state from import_run where job_id = $1 and owner_user_id = $2",
			[guard.owning_job_id, ownerId],
		);
		if (old.rows[0] && !["completed", "conflict"].includes(old.rows[0].state))
			throw new V4ApplyConflict("activation-adoption-conflict", item.ordinal);
		if (!old.rows[0]) {
			const remaining = await client.query(
				"select 1 from import_job where id = $1 and owner_user_id = $2 limit 1",
				[guard.owning_job_id, ownerId],
			);
			if (remaining.rowCount)
				throw new V4ApplyConflict("activation-adoption-conflict", item.ordinal);
		}
	}
	const expected = proof.expectedRelationships;
	const values = [
		taskId,
		proof.generation,
		sourceId,
		ownerId,
		jobId,
		proof.readinessOrdinal,
		expected.digest,
		expected.count,
		expected.bytes,
		JSON.stringify(expected.evidence),
	];
	if (!guard) {
		await client.query(
			`insert into task_notification_activation
			(task_id,status,generation,owning_source_id,owning_owner_user_id,owning_job_id,
			readiness_ordinal,expected_relationship_digest,expected_relationship_count,
			expected_relationship_bytes,expected_relationships)
			values ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
			values,
		);
	} else {
		const changed = await client.query(
			`update task_notification_activation set status='pending',generation=$2,
			completion_mode=null,owning_source_id=$3,owning_owner_user_id=$4,owning_job_id=$5,
			readiness_ordinal=$6,expected_relationship_digest=$7,expected_relationship_count=$8,
			expected_relationship_bytes=$9,expected_relationships=$10::jsonb,updated_at=now()
			where task_id=$1 and generation=$11 and status=$12`,
			[...values, guard.generation, guard.status],
		);
		if (changed.rowCount !== 1)
			throw new V4ApplyConflict(
				"activation-precondition-conflict",
				item.ordinal,
			);
	}
	state.guards.set(taskId, {
		task_id: taskId,
		status: "pending",
		generation: proof.generation,
		import_occurrence_cutoff: guard?.import_occurrence_cutoff ?? null,
		recipient_generation_cutoff: guard?.recipient_generation_cutoff ?? null,
		owning_source_id: sourceId,
		owning_owner_user_id: ownerId,
		owning_job_id: jobId,
		readiness_ordinal: proof.readinessOrdinal,
		expected_relationship_digest: expected.digest,
		expected_relationship_count: expected.count,
		expected_relationship_bytes: expected.bytes,
		expected_relationships: expected.evidence,
	});
}

function checkSeat(
	seat: { userId: string; membershipId: string },
	workspaceId: string,
	authority: V4ApplyAuthority,
	seats: Map<string, Seat>,
	ordinal: number,
): void {
	const live = seats.get(seat.membershipId);
	if (
		!authority.userIds.has(seat.userId) ||
		!live ||
		live.user_id !== seat.userId ||
		live.workspace_id !== workspaceId
	)
		throw new V4ApplyConflict("activation-seat-conflict", ordinal);
}

export async function publishV4Ready(
	client: PoolClient,
	jobId: string,
	authority: V4ApplyAuthority,
	seats: Map<string, Seat>,
	state: V4ApplyState,
	checkpoint: () => void,
): Promise<void> {
	const expected = new Map(
		authority.ready.map((item) => {
			if (!item.targetId || proofOf(item)?.kind !== "transition")
				throw new V4ApplyConflict("invalid-plan-evidence", item.ordinal);
			return [item.targetId, item] as const;
		}),
	);
	if (expected.size !== authority.ready.length)
		throw new V4ApplyConflict("activation-readiness-conflict", authority.start);
	const selected = await client.query<{ task_id: string }>(
		`select task_id from task_notification_activation
		where owning_job_id=$1 and status='pending' and readiness_ordinal < $2
		order by readiness_ordinal, task_id limit 101`,
		[jobId, authority.next],
	);
	if (
		selected.rows.length > 100 ||
		selected.rows.length !== expected.size ||
		selected.rows.some((row) => !expected.has(row.task_id))
	)
		throw new V4ApplyConflict("activation-readiness-conflict", authority.start);
	let totalPairs = 0;
	let totalBytes = 0;
	for (const { task_id: taskId } of selected.rows) {
		checkpoint();
		const item = expected.get(taskId);
		const guard = state.guards.get(taskId);
		if (
			!item ||
			!guard ||
			guard.status !== "pending" ||
			guard.owning_job_id !== jobId ||
			guard.readiness_ordinal >= authority.next ||
			guard.expected_relationships === null ||
			guard.expected_relationship_digest === null
		)
			throw new V4ApplyConflict(
				"activation-readiness-conflict",
				item?.ordinal ?? authority.start,
			);
		const ordinal = item.ordinal;
		const evidence = guard.expected_relationships;
		const frozen = proofOf(item)?.expectedRelationships;
		if (
			!frozen ||
			guard.expected_relationship_digest !== frozen.digest ||
			guard.expected_relationship_count !== frozen.count ||
			guard.expected_relationship_bytes !== frozen.bytes ||
			(await digestImportExpectedRelationships(evidence, checkpoint)) !==
				frozen.digest
		)
			throw new V4ApplyConflict("activation-evidence-conflict", ordinal);
		const task = await client.query<{
			id: string;
			list_id: string;
			parent_id: string | null;
			fallback_user_id: string | null;
			due_at: Date | null;
			owner_id: string;
			workspace_id: string;
		}>(
			`select t.*,l.owner_id,l.workspace_id
			from task t join list l on l.id=t.list_id where t.id=$1`,
			[taskId],
		);
		const live = task.rows[0];
		if (
			!live ||
			(await digestImportTarget("tasks", live, checkpoint)) !==
				(await digestImportTarget(
					"tasks",
					expectedTaskRow(item),
					checkpoint,
				)) ||
			live.workspace_id !== evidence.workspaceId ||
			live.fallback_user_id !== (evidence.escalationFallback?.userId ?? null) ||
			!authority.taskIds.includes(taskId) ||
			(!authority.listIds.includes(live.list_id) &&
				!authority.currentTasks.has(taskId))
		)
			throw new V4ApplyConflict("activation-target-conflict", ordinal);
		if (
			live.parent_id &&
			!authority.taskIds.includes(live.parent_id) &&
			!authority.parentIds.includes(live.parent_id)
		)
			throw new V4ApplyConflict("activation-target-conflict", ordinal);
		if (live.parent_id) {
			const parent = await client.query<{ list_id: string }>(
				"select list_id from task where id=$1",
				[live.parent_id],
			);
			if (parent.rows[0]?.list_id !== live.list_id)
				throw new V4ApplyConflict("activation-target-conflict", ordinal);
		}
		const original = authority.currentTasks.get(taskId);
		if (
			original &&
			(original.list_id !== live.list_id ||
				original.parent_id !== live.parent_id)
		)
			throw new V4ApplyConflict("activation-target-conflict", ordinal);
		const count = await client.query<{ count: string; bytes: string }>(
			"select count(*)::text as count, coalesce(sum(octet_length(a::text)),0)::text as bytes from task_assignee a where task_id=$1",
			[taskId],
		);
		totalPairs += Number(count.rows[0]?.count);
		totalBytes += Number(count.rows[0]?.bytes);
		bounded(totalPairs, ordinal);
		boundedBytes(totalBytes, ordinal);
		const pairs = await client.query<Pair>(
			"select id,task_id,user_id from task_assignee where task_id=$1 order by id",
			[taskId],
		);
		const assignees = pairs.rows.map((row) => row.user_id).sort(compare);
		if (
			assignees.length !== evidence.assignees.length ||
			assignees.some((id, index) => id !== evidence.assignees[index]?.userId) ||
			pairs.rows.some(
				(pair) =>
					!authority.currentPairs.has(pair.id) &&
					!authority.pairIds.includes(pair.id) &&
					!evidence.assignees.some((seat) => seat.userId === pair.user_id),
			)
		)
			throw new V4ApplyConflict("activation-pair-conflict", ordinal);
		for (const seat of evidence.assignees)
			checkSeat(seat, evidence.workspaceId, authority, seats, ordinal);
		if (evidence.ownerFallback) {
			if (assignees.length || evidence.ownerFallback.userId !== live.owner_id)
				throw new V4ApplyConflict("activation-fallback-conflict", ordinal);
			checkSeat(
				evidence.ownerFallback,
				evidence.workspaceId,
				authority,
				seats,
				ordinal,
			);
		} else if (!assignees.length)
			throw new V4ApplyConflict("activation-fallback-conflict", ordinal);
		if (evidence.escalationFallback)
			checkSeat(
				evidence.escalationFallback,
				evidence.workspaceId,
				authority,
				seats,
				ordinal,
			);
		const activeUsers = new Set(
			assignees.length
				? assignees
				: evidence.ownerFallback
					? [evidence.ownerFallback.userId]
					: [],
		);
		const now = (
			await client.query<{ now: Date }>("select clock_timestamp() as now")
		).rows[0]?.now;
		if (!now) throw new V4ApplyConflict("activation-clock-conflict", ordinal);
		const occurrence = guard.import_occurrence_cutoff ?? now;
		let cutoffMs = Math.max(occurrence.getTime(), now.getTime());
		if (guard.recipient_generation_cutoff)
			cutoffMs = Math.max(
				cutoffMs,
				guard.recipient_generation_cutoff.getTime(),
			);
		for (const recipient of state.recipients.values())
			if (recipient.task_id === taskId && recipient.cutoff)
				cutoffMs = Math.max(cutoffMs, recipient.cutoff.getTime());
		const cutoff = new Date(cutoffMs);
		for (const recipient of state.recipients.values()) {
			if (
				recipient.task_id !== taskId ||
				!recipient.active ||
				activeUsers.has(recipient.user_id)
			)
				continue;
			await client.query(
				"update task_notification_recipient set active=false,updated_at=now() where task_id=$1 and user_id=$2",
				[taskId, recipient.user_id],
			);
			recipient.active = false;
		}
		for (const userId of [...activeUsers].sort(compare)) {
			const key = pairKey(taskId, userId);
			const prior = state.recipients.get(key);
			if (prior) {
				await client.query(
					`update task_notification_recipient set active=true,generation=$3,cutoff=$4,
					updated_at=now() where task_id=$1 and user_id=$2`,
					[taskId, userId, guard.generation, cutoff],
				);
				prior.active = true;
				prior.generation = guard.generation;
				prior.cutoff = cutoff;
			} else {
				const suppressed =
					live.due_at && live.due_at < now ? live.due_at : null;
				await client.query(
					`insert into task_notification_recipient
					(task_id,user_id,active,generation,cutoff,overdue_suppressed_due_at)
					values ($1,$2,true,$3,$4,$5)`,
					[taskId, userId, guard.generation, cutoff, suppressed],
				);
				state.recipients.set(key, {
					task_id: taskId,
					user_id: userId,
					active: true,
					generation: guard.generation,
					cutoff,
					overdue_suppressed_due_at: suppressed,
				});
			}
		}
		const updated = await client.query(
			`update task_notification_activation set status='active',completion_mode='import',
			import_occurrence_cutoff=$2,recipient_generation_cutoff=$3,updated_at=now()
			where task_id=$1 and status='pending' and generation=$4 and owning_job_id=$5`,
			[taskId, occurrence, cutoff, guard.generation, jobId],
		);
		if (updated.rowCount !== 1)
			throw new V4ApplyConflict("activation-readiness-conflict", ordinal);
		guard.status = "active";
		guard.import_occurrence_cutoff = occurrence;
		guard.recipient_generation_cutoff = cutoff;
	}
}
