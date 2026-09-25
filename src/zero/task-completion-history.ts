import type { Transaction } from "@rocicorp/zero";
import type { CompletionEventInput } from "../domain/completion-history.ts";
import { randomId } from "../domain/random-id.ts";
import type { Schema } from "./schema.gen.ts";

type Query = (
	sql: string,
	values?: unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export function completionEventValues(event: CompletionEventInput) {
	return {
		id: randomId(),
		taskId: event.taskId,
		actorUserId: event.actorUserId,
		recordedAt: new Date(event.recordedAt),
		origin: event.origin,
		action: event.action,
		beforeDueAt:
			"beforeDueAt" in event && event.beforeDueAt !== null
				? new Date(event.beforeDueAt)
				: null,
		beforeDueAllDay: "beforeDueAllDay" in event ? event.beforeDueAllDay : null,
		beforeDone: "beforeDone" in event ? event.beforeDone : null,
		afterDueAt:
			"afterDueAt" in event && event.afterDueAt !== null
				? new Date(event.afterDueAt)
				: null,
		afterDone: "afterDone" in event ? event.afterDone : null,
		habitDate: "habitDate" in event ? event.habitDate : null,
		beforeHabitStatus:
			"beforeHabitStatus" in event ? event.beforeHabitStatus : null,
		afterHabitStatus:
			"afterHabitStatus" in event ? event.afterHabitStatus : null,
	};
}

const settings = [
	"ditero.completion_history_scope_present",
	"ditero.completion_history_actor_id",
	"ditero.completion_history_task_id",
	"ditero.completion_history_origin",
] as const;

async function setting(query: Query, name: string): Promise<string | null> {
	const rows = await query("select current_setting($1, true) as value", [name]);
	const value = rows[0]?.value;
	if (rows.length !== 1 || (value !== null && typeof value !== "string"))
		throw new Error("Completion history context lookup failed");
	return value;
}

async function setSetting(query: Query, name: string, value: string) {
	const rows = await query("select set_config($1, $2, true) as value", [
		name,
		value,
	]);
	if (
		rows.length !== 1 ||
		rows[0]?.value !== value ||
		(await setting(query, name)) !== value
	)
		throw new Error("Completion history context verification failed");
}

export async function appendZeroCompletionEvent(
	tx: Transaction<Schema>,
	event: CompletionEventInput,
): Promise<void> {
	if (tx.location !== "server") return;
	if (event.origin !== "member_mutation")
		throw new Error("Invalid Zero completion origin");
	const query: Query = async (statement, values = []) =>
		Array.from(await tx.dbTransaction.query(statement, values));
	const userId = await setting(query, "ditero.user_id");
	if (
		userId !== event.actorUserId ||
		(await setting(query, "ditero.activation_scope"))
	)
		throw new Error("Completion history authority context mismatch");
	const prior: (string | null)[] = [];
	for (const name of settings) prior.push(await setting(query, name));
	if (prior.some((value) => value))
		throw new Error("Nested completion history scope is forbidden");
	const values = ["1", event.actorUserId, event.taskId, event.origin];
	for (let i = 0; i < settings.length; i++)
		await setSetting(query, settings[i], values[i]);
	const row = completionEventValues(event);
	await query(
		`insert into task_completion_event
		(id, task_id, actor_user_id, recorded_at, origin, action, before_due_at,
		before_due_all_day, before_done, after_due_at, after_done, habit_date,
		before_habit_status, after_habit_status)
		values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		[
			row.id,
			row.taskId,
			row.actorUserId,
			row.recordedAt,
			row.origin,
			row.action,
			row.beforeDueAt,
			row.beforeDueAllDay,
			row.beforeDone,
			row.afterDueAt,
			row.afterDone,
			row.habitDate,
			row.beforeHabitStatus,
			row.afterHabitStatus,
		],
	);
	for (let i = 0; i < settings.length; i++)
		await setSetting(query, settings[i], prior[i] ?? "");
}
