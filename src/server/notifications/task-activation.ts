import type { QueryResultRow } from "pg";

export type TaskActivationClient = {
	query<Row extends QueryResultRow>(
		query: string,
		values?: unknown[],
	): Promise<{ rows: Row[] }>;
};
type Purpose = "producer" | "invite" | "ack" | "account-delete";
type Status = "pending" | "blocked" | "active";

export type TaskActivationLookup =
	| { kind: "native"; taskId: string }
	| {
			kind: "guarded";
			taskId: string;
			status: Status;
			generation: number;
			importOccurrenceCutoff: Date | null;
			recipientGenerationCutoff: Date | null;
			completionMode: "import" | "manual" | null;
	  };

type ScopeRow = QueryResultRow & { scope: string | null };
type TaskRow = QueryResultRow & { id: string };
type GuardRow = QueryResultRow & {
	task_id: string;
	scope: string | null;
	guard_task_id: string | null;
	status: unknown;
	generation: unknown;
	import_occurrence_cutoff: unknown;
	recipient_generation_cutoff: unknown;
	completion_mode: unknown;
};

// These literals are shared with the Drizzle transaction bridge. Only this
// fixed query set may pass through its raw-SQL adapter.
export const taskActivationSql = {
	readScope: "SELECT current_setting('ditero.activation_scope', true) AS scope",
	setScope: "SELECT set_config('ditero.activation_scope', $1, true) AS scope",
	clearScope: "SELECT set_config('ditero.activation_scope', '', true) AS scope",
	lockProducer: "SELECT id FROM task WHERE id = $1 FOR SHARE",
	lockWriter: "SELECT id FROM task WHERE id = $1 FOR UPDATE",
	guardEnvelope: `SELECT t.id AS task_id,
			current_setting('ditero.activation_scope', true) AS scope,
			g.task_id AS guard_task_id, g.status, g.generation,
			g.import_occurrence_cutoff, g.recipient_generation_cutoff, g.completion_mode
		FROM task t
		LEFT JOIN task_notification_activation g ON g.task_id = t.id
		WHERE t.id = $1`,
} as const;

// Caller owns the transaction, earlier authority/domain locks, and rollback on
// every rejection. This helper uses only that transaction client.

async function one<Row extends QueryResultRow>(
	client: TaskActivationClient,
	query: string,
	values?: unknown[],
): Promise<Row> {
	const { rows } = await client.query<Row>(query, values);
	if (rows.length !== 1)
		throw new Error("Task activation lookup returned an invalid envelope");
	return rows[0];
}

function cutoff(value: unknown): Date | null {
	if (value === null) return null;
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw new Error("Task activation cutoff is invalid");
	}
	return value;
}

async function withActivationScope<T>(
	client: TaskActivationClient,
	purpose: Purpose,
	callback: (client: TaskActivationClient) => Promise<T>,
): Promise<T> {
	const prior = await one<ScopeRow>(client, taskActivationSql.readScope);
	if (prior.scope !== null && prior.scope !== "") {
		throw new Error("Nested task activation scope is forbidden");
	}

	const configured = await one<ScopeRow>(client, taskActivationSql.setScope, [
		purpose,
	]);
	if (configured.scope !== purpose)
		throw new Error("Task activation scope setup failed");
	const verified = await one<ScopeRow>(client, taskActivationSql.readScope);
	if (verified.scope !== purpose) {
		throw new Error("Task activation scope requires an existing transaction");
	}
	const result = await callback(client);
	const cleared = await one<ScopeRow>(client, taskActivationSql.clearScope);
	if (cleared.scope !== "")
		throw new Error("Task activation scope cleanup failed");
	return result;
}

async function withTaskActivation<T>(
	client: TaskActivationClient,
	taskId: string,
	purpose: Purpose,
	callback: (
		lookup: TaskActivationLookup,
		client: TaskActivationClient,
	) => Promise<T>,
): Promise<T> {
	if (typeof taskId !== "string") {
		throw new Error("Task ID must be a string for activation lookup");
	}
	return withActivationScope(client, purpose, async () => {
		const lock =
			purpose === "producer"
				? taskActivationSql.lockProducer
				: taskActivationSql.lockWriter;
		const task = await one<TaskRow>(client, lock, [taskId]);
		if (task.id !== taskId) throw new Error("Task activation task lock failed");

		const row = await one<GuardRow>(client, taskActivationSql.guardEnvelope, [
			taskId,
		]);
		if (row.task_id !== taskId || row.scope !== purpose) {
			throw new Error("Task activation lookup scope or task mismatch");
		}

		let lookup: TaskActivationLookup;
		if (row.guard_task_id === null) {
			if (
				row.status !== null ||
				row.generation !== null ||
				row.import_occurrence_cutoff !== null ||
				row.recipient_generation_cutoff !== null ||
				row.completion_mode !== null
			) {
				throw new Error("Task activation native envelope is malformed");
			}
			lookup = { kind: "native", taskId };
		} else {
			if (row.guard_task_id !== taskId) {
				throw new Error("Task activation guard task mismatch");
			}
			if (
				row.status !== "pending" &&
				row.status !== "blocked" &&
				row.status !== "active"
			) {
				throw new Error("Task activation status is invalid");
			}
			if (
				!Number.isSafeInteger(row.generation) ||
				(row.generation as number) < 1
			) {
				throw new Error("Task activation generation is invalid");
			}
			if (
				row.completion_mode !== null &&
				row.completion_mode !== "import" &&
				row.completion_mode !== "manual"
			) {
				throw new Error("Task activation completion mode is invalid");
			}
			const importOccurrenceCutoff = cutoff(row.import_occurrence_cutoff);
			const recipientGenerationCutoff = cutoff(row.recipient_generation_cutoff);
			if (
				importOccurrenceCutoff !== null &&
				recipientGenerationCutoff !== null &&
				recipientGenerationCutoff.getTime() < importOccurrenceCutoff.getTime()
			) {
				throw new Error(
					"Task activation recipient cutoff precedes import cutoff",
				);
			}
			if (
				row.status === "active" &&
				(importOccurrenceCutoff === null ||
					recipientGenerationCutoff === null ||
					row.completion_mode === null)
			) {
				throw new Error(
					"Active task activation requires cutoffs and completion mode",
				);
			}
			if (row.status !== "active" && row.completion_mode !== null) {
				throw new Error(
					"Incomplete task activation cannot have a completion mode",
				);
			}
			lookup = {
				kind: "guarded",
				taskId,
				status: row.status,
				generation: row.generation as number,
				importOccurrenceCutoff,
				recipientGenerationCutoff,
				completionMode: row.completion_mode,
			};
		}

		return callback(lookup, client);
	});
}

export function withProducerTaskActivation<T>(
	client: TaskActivationClient,
	taskId: string,
	callback: (
		lookup: TaskActivationLookup,
		client: TaskActivationClient,
	) => Promise<T>,
): Promise<T> {
	return withTaskActivation(client, taskId, "producer", callback);
}

// Preliminary scans may read guard and recipient rows under producer RLS, but
// each enqueue still needs the task-locked authoritative lookup above.
export function withProducerActivationScan<T>(
	client: TaskActivationClient,
	callback: (client: TaskActivationClient) => Promise<T>,
): Promise<T> {
	return withActivationScope(client, "producer", callback);
}

export function withInviteTaskActivation<T>(
	client: TaskActivationClient,
	taskId: string,
	callback: (
		lookup: TaskActivationLookup,
		client: TaskActivationClient,
	) => Promise<T>,
): Promise<T> {
	return withTaskActivation(client, taskId, "invite", callback);
}

export function withAckTaskActivation<T>(
	client: TaskActivationClient,
	taskId: string,
	callback: (
		lookup: TaskActivationLookup,
		client: TaskActivationClient,
	) => Promise<T>,
): Promise<T> {
	return withTaskActivation(client, taskId, "ack", callback);
}

export function withAccountDeletionTaskActivation<T>(
	client: TaskActivationClient,
	taskId: string,
	callback: (
		lookup: TaskActivationLookup,
		client: TaskActivationClient,
	) => Promise<T>,
): Promise<T> {
	return withTaskActivation(client, taskId, "account-delete", callback);
}
