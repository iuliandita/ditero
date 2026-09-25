import type { Pool, PoolClient } from "pg";
import {
	digestImportExpectedRelationships,
	type ImportRelationshipEvidence,
} from "../../domain/portability/import-apply-plan.ts";
import { hashImportValue } from "../../domain/portability/import-digest.ts";
import type { PortableJson } from "../../domain/portability/v1.ts";
import { type Role, WRITE_ROLES } from "../../domain/role.ts";
import { publishManualTaskRecipients } from "../../zero/task-activation-transition.ts";
import { importTransaction } from "./import-plan-store.ts";

const MAX_ROWS = 50_000;
const MAX_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE = 100;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class ImportRecoveryError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code);
	}
}

function fail(code: string, status = 409): never {
	throw new ImportRecoveryError(code, status);
}

type TaskRow = {
	id: string;
	list_id: string;
	parent_id: string | null;
	fallback_user_id: string | null;
	due_at: Date | null;
	title: string;
	workspace_id: string;
	owner_id: string;
	list_title: string;
};
type GuardRow = {
	task_id: string;
	status: "pending" | "blocked" | "active";
	generation: number;
	completion_mode: "import" | "manual" | null;
	manual_review_digest: string | null;
	import_occurrence_cutoff: Date | null;
	recipient_generation_cutoff: Date | null;
	blocked_reason: string | null;
	readiness_ordinal: number;
	owning_source_id: string | null;
	owning_owner_user_id: string | null;
	owning_job_id: string | null;
	expected_relationship_digest: string | null;
	expected_relationship_count: number | null;
	expected_relationship_bytes: number | null;
	expected_relationships: ImportRelationshipEvidence | null;
};
type PairRow = { id: string; task_id: string; user_id: string };
type RecipientRow = {
	user_id: string;
	active: boolean;
	generation: number;
	cutoff: Date | null;
	overdue_suppressed_due_at: Date | null;
};
type SeatRow = { id: string; user_id: string; role: Role; name: string };
type ReviewItem = {
	kind:
		| "current-assignee"
		| "expected-assignee"
		| "owner-fallback"
		| "escalation-fallback";
	name: string | null;
	state: "present" | "missing" | "changed";
};
type LedgerState =
	| "unfinished"
	| "terminal"
	| "plan-present"
	| "unavailable"
	| "none";

type Snapshot = {
	task: TaskRow;
	guard: GuardRow;
	pairs: PairRow[];
	recipients: RecipientRow[];
	seats: Map<string, SeatRow>;
	parentListId: string | null;
	parentTitle: string | null;
	ledgerState: LedgerState;
	items: ReviewItem[];
	digest: string;
	evidence: { rows: number; bytes: number };
	lockedUsers: string[];
};

function iso(value: Date | null): string | null {
	return value?.toISOString() ?? null;
}

function validEvidence(value: unknown): value is ImportRelationshipEvidence {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const evidence = value as ImportRelationshipEvidence;
	const seat = (
		entry: unknown,
	): entry is { userId: string; membershipId: string } =>
		!!entry &&
		typeof entry === "object" &&
		typeof (entry as { userId?: unknown }).userId === "string" &&
		typeof (entry as { membershipId?: unknown }).membershipId === "string";
	return (
		evidence.version === 1 &&
		typeof evidence.workspaceId === "string" &&
		Array.isArray(evidence.assignees) &&
		evidence.assignees.length <= MAX_ROWS &&
		evidence.assignees.every(seat) &&
		(evidence.ownerFallback === null || seat(evidence.ownerFallback)) &&
		(evidence.escalationFallback === null || seat(evidence.escalationFallback))
	);
}

async function taskAndGuard(client: PoolClient, taskId: string) {
	const task = (
		await client.query<TaskRow>(
			`select t.id,t.list_id,t.parent_id,t.fallback_user_id,t.due_at,t.title,
			l.workspace_id,l.owner_id,l.title as list_title
			from task t join list l on l.id=t.list_id where t.id=$1`,
			[taskId],
		)
	).rows[0];
	if (!task) fail("not-found", 404);
	const role = (
		await client.query<{ role: Role }>(
			`select m.role from membership m join "user" u on u.id=m.user_id
			where m.workspace_id=$1 and m.user_id=current_setting('ditero.user_id',true)
			and u.deleted_at is null`,
			[task.workspace_id],
		)
	).rows[0]?.role;
	if (!role || !WRITE_ROLES.has(role)) fail("not-found", 404);
	const guard = (
		await client.query<GuardRow>(
			"select * from task_notification_activation where task_id=$1",
			[taskId],
		)
	).rows[0];
	if (!guard) fail("not-found", 404);
	return { task, guard };
}

async function probe(
	client: PoolClient,
	table: "task_assignee" | "task_notification_recipient",
	taskId: string,
): Promise<{ rows: number; bytes: number }> {
	const row = (
		await client.query<{ count: string; bytes: string }>(
			`select count(*)::text as count,coalesce(sum(octet_length(x::text)),0)::text as bytes
			from ${table} x where task_id=$1`,
			[taskId],
		)
	).rows[0];
	const result = { rows: Number(row?.count), bytes: Number(row?.bytes) };
	if (
		!Number.isSafeInteger(result.rows) ||
		!Number.isSafeInteger(result.bytes) ||
		result.rows > MAX_ROWS ||
		result.bytes > MAX_BYTES
	)
		fail("activation-review-limit", 413);
	return result;
}

async function ledgerState(
	client: PoolClient,
	guard: GuardRow,
	actorId: string,
): Promise<LedgerState> {
	if (!guard.owning_job_id && !guard.owning_owner_user_id) return "none";
	if (!guard.owning_job_id || !guard.owning_owner_user_id) return "unavailable";
	const ownerId = guard.owning_owner_user_id;
	const switched = await client.query<{ identity: string; scope: string }>(
		`select set_config('ditero.user_id',$1,true) as identity,
		coalesce(current_setting('ditero.activation_scope',true),'') as scope`,
		[ownerId],
	);
	if (switched.rows[0]?.identity !== ownerId || switched.rows[0].scope !== "")
		fail("activation-context-conflict");
	let state: LedgerState;
	try {
		const rows = (
			await client.query<{ job_exists: boolean; run_state: string | null }>(
				`select exists(select 1 from import_job j where j.id=$1 and j.owner_user_id=$2) as job_exists,
				(select r.state from import_run r where r.job_id=$1 and r.owner_user_id=$2) as run_state`,
				[guard.owning_job_id, ownerId],
			)
		).rows;
		const row = rows[0];
		state = !row?.job_exists
			? "unavailable"
			: row.run_state === "pending" || row.run_state === "running"
				? "unfinished"
				: row.run_state === "completed" || row.run_state === "conflict"
					? "terminal"
					: "plan-present";
	} finally {
		const restored = await client.query<{ identity: string }>(
			"select set_config('ditero.user_id',$1,true) as identity",
			[actorId],
		);
		if (restored.rows[0]?.identity !== actorId)
			fail("activation-context-conflict");
	}
	return state;
}

function evidenceUsers(guard: GuardRow): string[] {
	const evidence = guard.expected_relationships;
	if (!evidence) return [];
	if (!validEvidence(evidence)) fail("activation-evidence-conflict");
	return [
		...evidence.assignees.map((seat) => seat.userId),
		...(evidence.ownerFallback ? [evidence.ownerFallback.userId] : []),
		...(evidence.escalationFallback
			? [evidence.escalationFallback.userId]
			: []),
	];
}

type EvidenceBudget = { rows: number; bytes: number };

export function publicationEvidenceBudget(
	expected: EvidenceBudget,
	pairs: EvidenceBudget,
	retained: EvidenceBudget,
): EvidenceBudget {
	const seed = {
		rows: expected.rows + pairs.rows,
		bytes: expected.bytes + pairs.bytes,
	};
	if (
		[seed.rows, seed.bytes, retained.rows, retained.bytes].some(
			(value) => !Number.isSafeInteger(value) || value < 0,
		) ||
		seed.rows + retained.rows > MAX_ROWS ||
		seed.bytes + retained.bytes > MAX_BYTES
	)
		fail("activation-review-limit", 413);
	return seed;
}

function reviewBudget(
	guard: GuardRow,
	pairs: EvidenceBudget,
	retained: EvidenceBudget,
) {
	return publicationEvidenceBudget(
		{
			rows: guard.expected_relationship_count ?? 0,
			bytes: guard.expected_relationship_bytes ?? 0,
		},
		pairs,
		retained,
	);
}

async function buildSnapshot(
	client: PoolClient,
	actorId: string,
	taskId: string,
	lockedUsers: string[],
): Promise<Snapshot> {
	const { task: discovered, guard: observed } = await taskAndGuard(
		client,
		taskId,
	);
	await client.query("select id from workspace where id=$1 for share", [
		discovered.workspace_id,
	]);
	const seats = (
		await client.query<SeatRow>(
			`select m.id,m.user_id,m.role,u.name from membership m
			join "user" u on u.id=m.user_id and u.deleted_at is null
			where m.workspace_id=$1 and m.user_id=any($2::text[])
			order by m.id for share`,
			[discovered.workspace_id, lockedUsers],
		)
	).rows;
	const actorSeat = seats.find((seat) => seat.user_id === actorId);
	if (!actorSeat || !WRITE_ROLES.has(actorSeat.role)) fail("not-found", 404);
	const list = (
		await client.query<{
			id: string;
			workspace_id: string;
			owner_id: string;
			title: string;
		}>(
			"select id,workspace_id,owner_id,title from list where id=$1 for share",
			[discovered.list_id],
		)
	).rows[0];
	if (!list || list.workspace_id !== discovered.workspace_id)
		fail("activation-structure-conflict");
	const ids = [
		...new Set([
			taskId,
			...(discovered.parent_id ? [discovered.parent_id] : []),
		]),
	].sort(compare);
	const tasks = (
		await client.query<{
			id: string;
			list_id: string;
			parent_id: string | null;
			fallback_user_id: string | null;
			due_at: Date | null;
			title: string;
		}>(
			"select id,list_id,parent_id,fallback_user_id,due_at,title from task where id=any($1::text[]) order by id for update",
			[ids],
		)
	).rows;
	const live = tasks.find((row) => row.id === taskId);
	if (!live || (discovered.parent_id && tasks.length !== 2))
		fail("activation-structure-conflict");
	const parentListId = discovered.parent_id
		? (tasks.find((row) => row.id === discovered.parent_id)?.list_id ?? null)
		: null;
	const parentTitle = discovered.parent_id
		? (tasks.find((row) => row.id === discovered.parent_id)?.title ?? null)
		: null;
	if (
		live.list_id !== list.id ||
		live.parent_id !== discovered.parent_id ||
		(parentListId && parentListId !== list.id)
	)
		fail("activation-structure-conflict");
	const task: TaskRow = {
		...live,
		workspace_id: list.workspace_id,
		owner_id: list.owner_id,
		list_title: list.title,
	};
	if (
		task.workspace_id !== discovered.workspace_id ||
		task.owner_id !== discovered.owner_id
	)
		fail("activation-review-stale");
	const guard = (
		await client.query<GuardRow>(
			"select * from task_notification_activation where task_id=$1 for update",
			[taskId],
		)
	).rows[0];
	if (
		!guard ||
		guard.generation !== observed.generation ||
		guard.status !== observed.status ||
		JSON.stringify(evidenceUsers(guard).sort(compare)) !==
			JSON.stringify(evidenceUsers(observed).sort(compare))
	)
		fail("activation-review-stale");
	const pairProbe = await probe(client, "task_assignee", taskId);
	const recipientProbe = await probe(
		client,
		"task_notification_recipient",
		taskId,
	);
	const publicationEvidence = reviewBudget(guard, pairProbe, recipientProbe);
	const pairs = (
		await client.query<PairRow>(
			"select id,task_id,user_id from task_assignee where task_id=$1 order by id for share",
			[taskId],
		)
	).rows;
	const recipients = (
		await client.query<RecipientRow>(
			`select user_id,active,generation,cutoff,overdue_suppressed_due_at
			from task_notification_recipient where task_id=$1 order by user_id for update`,
			[taskId],
		)
	).rows;
	if (
		pairs.length !== pairProbe.rows ||
		recipients.length !== recipientProbe.rows
	)
		fail("activation-review-stale");
	const seatMap = new Map(seats.map((seat) => [seat.user_id, seat]));
	const expected = guard.expected_relationships;
	if (!expected || !guard.expected_relationship_digest)
		fail("activation-evidence-conflict");
	if (!validEvidence(expected)) fail("activation-evidence-conflict");
	if (
		(await digestImportExpectedRelationships(expected, () => {})) !==
		guard.expected_relationship_digest
	)
		fail("activation-evidence-conflict");
	const expectedSeat = (entry: {
		userId: string;
		membershipId: string;
	}): ReviewItem["state"] => {
		const seat = seatMap.get(entry.userId);
		return seat?.id === entry.membershipId
			? "present"
			: seat
				? "changed"
				: "missing";
	};
	const name = (id: string) => seatMap.get(id)?.name ?? null;
	const pairUsers = new Set(pairs.map((pair) => pair.user_id));
	const items: ReviewItem[] = [
		...pairs.map((pair) => ({
			kind: "current-assignee" as const,
			name: name(pair.user_id),
			state: seatMap.has(pair.user_id)
				? ("present" as const)
				: ("missing" as const),
		})),
		...(expected?.assignees ?? []).map((entry) => ({
			kind: "expected-assignee" as const,
			name: name(entry.userId),
			state: !pairUsers.has(entry.userId)
				? ("missing" as const)
				: expectedSeat(entry),
		})),
		...(expected?.ownerFallback
			? [
					{
						kind: "owner-fallback" as const,
						name: name(expected.ownerFallback.userId),
						state:
							pairs.length > 0 ||
							task.owner_id !== expected.ownerFallback.userId
								? ("changed" as const)
								: expectedSeat(expected.ownerFallback),
					},
				]
			: []),
		...(expected?.escalationFallback
			? [
					{
						kind: "escalation-fallback" as const,
						name: name(expected.escalationFallback.userId),
						state:
							task.fallback_user_id !== expected.escalationFallback.userId
								? ("changed" as const)
								: expectedSeat(expected.escalationFallback),
					},
				]
			: []),
	];
	const currentRecipients = pairs.length
		? pairs.map((pair) => pair.user_id)
		: [task.owner_id];
	if (
		currentRecipients.some((id) => !seatMap.has(id)) ||
		(task.fallback_user_id && !seatMap.has(task.fallback_user_id))
	)
		fail("activation-structure-conflict");
	if (currentRecipients.some((id) => !lockedUsers.includes(id)))
		fail("activation-review-stale");
	const owningRun = await ledgerState(client, guard, actorId);
	const digestInput = {
		task: [
			task.id,
			task.list_id,
			task.parent_id,
			task.fallback_user_id,
			iso(task.due_at),
			task.title,
			task.workspace_id,
			task.owner_id,
			task.list_title,
		],
		guard: [
			guard.status,
			guard.generation,
			guard.completion_mode,
			guard.blocked_reason,
			iso(guard.import_occurrence_cutoff),
			iso(guard.recipient_generation_cutoff),
			guard.owning_source_id,
			guard.owning_owner_user_id,
			guard.owning_job_id,
			guard.readiness_ordinal,
			guard.expected_relationship_digest,
			guard.expected_relationships,
		],
		pairs: pairs.map((row) => [row.id, row.user_id]),
		recipients: recipients.map((row) => [
			row.user_id,
			row.active,
			row.generation,
			iso(row.cutoff),
			iso(row.overdue_suppressed_due_at),
		]),
		seats: [...seatMap.values()]
			.map((row) => [row.id, row.user_id, row.role, row.name])
			.sort((a, b) => compare(String(a[0]), String(b[0]))),
		parentListId,
		parentTitle,
		owningRun,
	};
	const digest = await hashImportValue(
		"ditero-manual-activation-review-v1",
		digestInput as PortableJson,
		() => {},
	);
	return {
		task,
		guard,
		pairs,
		recipients,
		seats: seatMap,
		parentListId,
		parentTitle,
		ledgerState: owningRun,
		items,
		digest,
		evidence: publicationEvidence,
		lockedUsers,
	};
}

async function recover<T>(
	pool: Pool,
	actorId: string,
	taskId: string,
	callback: (client: PoolClient, snapshot: Snapshot) => Promise<T>,
	options: { signal?: AbortSignal; deadline?: number } = {},
): Promise<T> {
	let discoveredUsers: string[] = [];
	return importTransaction(
		pool,
		actorId,
		async (client) => {
			const snapshot = await buildSnapshot(
				client,
				actorId,
				taskId,
				discoveredUsers,
			);
			return callback(client, snapshot);
		},
		options.signal,
		options.deadline,
		async (client) => {
			const { task, guard } = await taskAndGuard(client, taskId);
			const pairProbe = await probe(client, "task_assignee", taskId);
			const recipientProbe = await probe(
				client,
				"task_notification_recipient",
				taskId,
			);
			reviewBudget(guard, pairProbe, recipientProbe);
			const pairUsers = (
				await client.query<{ user_id: string }>(
					"select user_id from task_assignee where task_id=$1 order by user_id",
					[taskId],
				)
			).rows.map((row) => row.user_id);
			const recipientUsers = (
				await client.query<{ user_id: string }>(
					"select user_id from task_notification_recipient where task_id=$1 order by user_id",
					[taskId],
				)
			).rows.map((row) => row.user_id);
			const candidates = [
				...new Set([
					actorId,
					task.owner_id,
					...(task.fallback_user_id ? [task.fallback_user_id] : []),
					...pairUsers,
					...recipientUsers,
					...evidenceUsers(guard),
				]),
			].sort(compare);
			const live = (
				await client.query<{ id: string }>(
					'select id from "user" where id=any($1::text[]) and deleted_at is null order by id',
					[candidates],
				)
			).rows.map((row) => row.id);
			discoveredUsers = live;
			return live;
		},
	);
}

export async function reviewTaskActivation(
	pool: Pool,
	actorId: string,
	taskId: string,
	page = 0,
	options: { signal?: AbortSignal; deadline?: number } = {},
) {
	if (!Number.isSafeInteger(page) || page < 0 || page > MAX_ROWS / PAGE_SIZE)
		fail("invalid-page", 400);
	return recover(
		pool,
		actorId,
		taskId,
		async (_client, snapshot) => {
			if (snapshot.guard.status === "active") fail("activation-already-active");
			const count = snapshot.items.length;
			return {
				task: {
					title: snapshot.task.title,
					listTitle: snapshot.task.list_title,
					parentTitle: snapshot.parentTitle,
					fallbackPresent: snapshot.task.fallback_user_id !== null,
					fallbackName: snapshot.task.fallback_user_id
						? (snapshot.seats.get(snapshot.task.fallback_user_id)?.name ?? null)
						: null,
					ownerFallbackPresent: snapshot.pairs.length === 0,
					ownerFallbackName:
						snapshot.pairs.length === 0
							? (snapshot.seats.get(snapshot.task.owner_id)?.name ?? null)
							: null,
				},
				status: snapshot.guard.status,
				generation: snapshot.guard.generation,
				owningRun: snapshot.ledgerState,
				counts: {
					currentAssignees: snapshot.pairs.length,
					expectedLinks: snapshot.items.filter(
						(item) => item.kind !== "current-assignee",
					).length,
					missingLinks: snapshot.items.filter(
						(item) => item.state === "missing",
					).length,
					changedLinks: snapshot.items.filter(
						(item) => item.state === "changed",
					).length,
				},
				missingLinksRemainMissing: true,
				reviewDigest: snapshot.digest,
				items: snapshot.items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
				page,
				totalItems: count,
				pageSize: PAGE_SIZE,
			};
		},
		options,
	);
}

export async function finishTaskActivation(
	pool: Pool,
	actorId: string,
	taskId: string,
	reviewDigest: string,
	options: { signal?: AbortSignal; deadline?: number } = {},
) {
	return recover(
		pool,
		actorId,
		taskId,
		async (client, snapshot) => {
			if (snapshot.guard.status === "active") {
				if (
					snapshot.guard.completion_mode === "manual" &&
					snapshot.guard.manual_review_digest === reviewDigest
				)
					return {
						code: "already-completed",
						generation: snapshot.guard.generation,
					};
				fail("activation-already-active");
			}
			if (snapshot.digest !== reviewDigest) fail("activation-review-stale");
			const query = async (sql: string, args: unknown[]) =>
				(await client.query(sql, args)).rows;
			await publishManualTaskRecipients(
				query,
				taskId,
				{
					userIds: snapshot.lockedUsers,
					workspaceIds: [snapshot.task.workspace_id],
					evidence: snapshot.evidence,
				},
				snapshot.guard.generation,
				reviewDigest,
			);
			return { code: "completed", generation: snapshot.guard.generation + 1 };
		},
		options,
	);
}
