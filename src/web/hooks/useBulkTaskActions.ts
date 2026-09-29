import { useZero } from "@rocicorp/zero/react";
import { useCallback, useMemo } from "react";
import { randomId } from "../../domain/random-id.ts";
import { keyBetween } from "../../domain/sort-key.ts";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type { List, schema, Task } from "../../zero/schema.gen.ts";
import { useConfirm } from "../components/ui/confirm.tsx";
import { useSnackbar } from "../components/ui/snackbar.tsx";
import { onMutationFailure } from "../lib/mutation-outcome.ts";
import { inputsToDue } from "../lib/task-display.ts";

type Run = (mutation: { client: Promise<unknown> }) => unknown;
type Mutation = { client: Promise<unknown>; server: Promise<unknown> };

// Bulk edits over selected rows, one existing mutator call per task, so every
// write keeps its own per-task authorization. One snack speaks for the batch:
// its key is minted per batch so a failure can only replace its own
// confirmation. Failures count up in that one snack; a connection drop is not
// a failure (onMutationFailure ignores a "zero" server settle).
export function useBulkTaskActions(run: Run) {
	const zero = useZero<typeof schema>();
	const { show, fail, dismissKey } = useSnackbar();
	const confirm = useConfirm();

	const each = useCallback(
		<T>(
			items: readonly T[],
			mutate: (item: T) => Mutation,
			failed: (count: number) => string,
			key = `bulk:${randomId()}`,
		) => {
			let failures = 0;
			for (const item of items) {
				const mutation = mutate(item);
				run(mutation);
				onMutationFailure(mutation, () => {
					failures += 1;
					fail({ key, message: failed(failures) });
				});
			}
		},
		[run, fail],
	);

	const complete = useCallback(
		(tasks: readonly Task[]) => {
			const open = tasks.filter((t) => !t.done);
			if (open.length === 0) return;
			// task.complete on a recurring task advances it to the next date;
			// reopening would not restore that, so Undo leaves those alone and
			// the snack says so.
			const undoable = open.filter((t) => t.rrule == null);
			const recurring = open.length - undoable.length;
			const key = `bulk:${randomId()}`;
			const done = m.snackbar_bulk_completed({ count: open.length });
			const message =
				recurring === 0
					? done
					: undoable.length > 0
						? `${done} ${m.snackbar_bulk_undo_skips_recurring({ count: recurring })}`
						: `${done} ${m.snackbar_bulk_recurring_advanced({ count: recurring })}`;
			show({
				key,
				message,
				action:
					undoable.length > 0
						? {
								label: m.action_undo(),
								run: () => {
									dismissKey(key);
									for (const t of undoable)
										run(
											zero.mutate(
												mutators.task.update({ id: t.id, done: false }),
											),
										);
								},
							}
						: undefined,
			});
			each(
				open,
				(t) => zero.mutate(mutators.task.complete({ id: t.id })),
				(count) => m.snackbar_bulk_complete_failed({ count }),
				key,
			);
		},
		[zero, show, dismissKey, run, each],
	);

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
			// Appended in their current order, each after the one before.
			const plan = moving.map((t) => {
				last = keyBetween(last, null);
				return { task: t, sortKey: last };
			});
			const key = `bulk:${randomId()}`;
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
						for (const { task } of plan)
							run(
								zero.mutate(
									mutators.task.move({
										id: task.id,
										listId: task.listId,
										sortKey: task.sortKey,
									}),
								),
							);
					},
				},
			});
			each(
				plan,
				(p) =>
					zero.mutate(
						mutators.task.move({
							id: p.task.id,
							listId: target.id,
							sortKey: p.sortKey,
						}),
					),
				(count) => m.snackbar_bulk_move_failed({ count }),
				key,
			);
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
		() => ({ complete, move, setDue, setPriority, remove }),
		[complete, move, setDue, setPriority, remove],
	);
}
