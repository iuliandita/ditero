import { useZero } from "@rocicorp/zero/react";
import { useCallback, useMemo } from "react";
import { randomId } from "../../domain/random-id.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type { List, schema, Task } from "../../zero/schema.gen.ts";
import { useConfirm } from "../components/ui/confirm.tsx";
import { useSnackbar } from "../components/ui/snackbar.tsx";
import { runBatch } from "../lib/bulk-batch.ts";
import { inputsToDue } from "../lib/task-display.ts";

type Run = (mutation: { client: Promise<unknown> }) => unknown;
type Mutation = { client: Promise<unknown>; server: Promise<unknown> };

// Bulk edits over selected rows: one existing mutator call per task, so every
// write keeps its own per-task authorization. Each call applies optimistically
// the moment it is made (Zero's client write is local), so a batch never waits
// on the server and the list reflects it at once; the server answers each one
// in its own time.
//
// One snack confirms the batch and carries its Undo. Failures are reported
// under a separate key, so they queue behind that snack instead of replacing
// it, and Undo only takes back the tasks whose write did not fail. A
// connection drop is not a failure (onMutationFailure ignores a "zero" server
// settle: the write is queued and lands on reconnect).
export function useBulkTaskActions(run: Run) {
	const zero = useZero<typeof schema>();
	const { show, fail, dismissKey } = useSnackbar();
	const confirm = useConfirm();

	// Returns the ids whose write failed so far; the set fills as answers come in.
	const each = useCallback(
		<T extends { id: string }>(
			items: readonly T[],
			mutate: (item: T) => Mutation,
			failed: (count: number) => string,
		): ReadonlySet<string> => {
			const failedKey = `bulk-failed:${randomId()}`;
			return runBatch(items, mutate, run, (count) =>
				fail({ key: failedKey, message: failed(count) }),
			);
		},
		[run, fail],
	);

	const complete = useCallback(
		(tasks: readonly Task[], variant: "tasks" | "shopping" = "tasks") => {
			const open = tasks.filter((t) => !t.done);
			if (open.length === 0) return;
			// task.complete on a recurring task advances it to the next date;
			// reopening would not restore that, so Undo leaves those alone and
			// the snack says so.
			const undoable = open.filter((t) => t.rrule == null);
			const recurring = open.length - undoable.length;
			const key = `bulk:${randomId()}`;
			const done =
				variant === "shopping"
					? m.snackbar_bulk_checked({ count: open.length })
					: m.snackbar_bulk_completed({ count: open.length });
			const message =
				recurring === 0
					? done
					: undoable.length > 0
						? `${done} ${m.snackbar_bulk_undo_skips_recurring({ count: recurring })}`
						: `${done} ${m.snackbar_bulk_recurring_advanced({ count: recurring })}`;
			const failed = each(
				open,
				(t) => zero.mutate(mutators.task.complete({ id: t.id })),
				(count) => m.snackbar_bulk_complete_failed({ count }),
			);
			show({
				key,
				message,
				action:
					undoable.length > 0
						? {
								label: m.action_undo(),
								run: () => {
									dismissKey(key);
									for (const t of undoable) {
										if (failed.has(t.id)) continue;
										run(
											zero.mutate(
												mutators.task.update({ id: t.id, done: false }),
											),
										);
									}
								},
							}
						: undefined,
			});
		},
		[zero, show, dismissKey, run, each],
	);

	// Unchecking is the everyday correction in a shopping list and needs no
	// Undo, the same as unchecking one row.
	const uncheck = useCallback(
		(tasks: readonly Task[]) => {
			each(
				tasks.filter((t) => t.done),
				(t) => zero.mutate(mutators.task.update({ id: t.id, done: false })),
				(count) => m.snackbar_bulk_update_failed({ count }),
			);
		},
		[zero, each],
	);

	// `tasks` arrive in on-screen order and land after the target's last task
	// in that same order.
	const move = useCallback(
		(tasks: readonly Task[], target: List, targetTasks: readonly Task[]) => {
			const moving = tasks.filter((t) => t.listId !== target.id);
			if (moving.length === 0) return;
			let last = targetTasks
				.filter((t) => t.parentId == null)
				.reduce<string | null>(
					(max, t) => (max == null || t.sortKey > max ? t.sortKey : max),
					null,
				);
			const plan = moving.map((t) => {
				last = keyBetween(last, null);
				return { id: t.id, from: t, sortKey: last };
			});
			const key = `bulk:${randomId()}`;
			const failed = each(
				plan,
				(p) =>
					zero.mutate(
						mutators.task.move({
							id: p.id,
							listId: target.id,
							sortKey: p.sortKey,
						}),
					),
				(count) => m.snackbar_bulk_move_failed({ count }),
			);
			show({
				key,
				message: m.snackbar_bulk_moved({
					count: moving.length,
					list: target.title,
				}),
				action: {
					label: m.action_undo(),
					run: () => {
						dismissKey(key);
						for (const { id, from } of plan) {
							if (failed.has(id)) continue;
							run(
								zero.mutate(
									mutators.task.move({
										id,
										listId: from.listId,
										sortKey: from.sortKey,
									}),
								),
							);
						}
					},
				},
			});
		},
		[zero, show, dismissKey, run, each],
	);

	const setDue = useCallback(
		(tasks: readonly Task[], date: string, time: string | null) => {
			const { dueAt, dueAllDay } = inputsToDue(date, time ?? "");
			each(
				tasks,
				(t) =>
					zero.mutate(mutators.task.update({ id: t.id, dueAt, dueAllDay })),
				(count) => m.snackbar_bulk_update_failed({ count }),
			);
		},
		[zero, each],
	);

	const setPriority = useCallback(
		(tasks: readonly Task[], priority: number) => {
			each(
				tasks,
				(t) => zero.mutate(mutators.task.update({ id: t.id, priority })),
				(count) => m.snackbar_bulk_update_failed({ count }),
			);
		},
		[zero, each],
	);

	const clearQuantity = useCallback(
		(tasks: readonly Task[]) => {
			each(
				tasks.filter((t) => t.quantity != null || t.unit != null),
				(t) =>
					zero.mutate(
						mutators.task.update({ id: t.id, quantity: null, unit: null }),
					),
				(count) => m.snackbar_bulk_update_failed({ count }),
			);
		},
		[zero, each],
	);

	// Resolves true once confirmed and sent, so the caller clears the selection
	// only for a delete that happened.
	const remove = useCallback(
		async (tasks: readonly Task[]): Promise<boolean> => {
			if (tasks.length === 0) return false;
			const ok = await confirm({
				title: m.bulk_delete_title({ count: tasks.length }),
				body: m.bulk_delete_confirm({ count: tasks.length }),
				confirmLabel: m.action_delete(),
				destructive: true,
			});
			if (!ok) return false;
			each(
				tasks,
				(t) => zero.mutate(mutators.task.delete({ id: t.id })),
				(count) => m.snackbar_bulk_delete_failed({ count }),
			);
			return true;
		},
		[zero, confirm, each],
	);

	return useMemo(
		() => ({
			complete,
			uncheck,
			move,
			setDue,
			setPriority,
			clearQuantity,
			remove,
		}),
		[complete, uncheck, move, setDue, setPriority, clearQuantity, remove],
	);
}
