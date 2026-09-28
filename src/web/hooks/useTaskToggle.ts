import { useZero } from "@rocicorp/zero/react";
import { useCallback } from "react";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type { schema, Task } from "../../zero/schema.gen.ts";
import { useSnackbar } from "../components/ui/snackbar.tsx";
import { onMutationFailure } from "../lib/mutation-outcome.ts";

type Run = (mutation: { client: Promise<unknown> }) => unknown;

// Check/uncheck a row and confirm a completion in the shared snackbar. The
// snackbar is raised together with the optimistic write, never after the
// server answers; a refusal from either side replaces it with an error. Undo reopens through the same task.update the uncheck path
// already uses; reopening by hand retracts the snack so it never offers Undo
// for a task that is already open. A recurring task gets no Undo: task.complete advanced its due
// date to the next occurrence, and reopening would not restore that.
export function useTaskToggle(run: Run) {
	const zero = useZero<typeof schema>();
	const { show, dismissKey } = useSnackbar();
	return useCallback(
		(task: Pick<Task, "id" | "title" | "done" | "rrule">) => {
			const reopen = () =>
				run(zero.mutate(mutators.task.update({ id: task.id, done: false })));
			if (task.done) {
				dismissKey(task.id);
				reopen();
				return;
			}
			const mutation = zero.mutate(mutators.task.complete({ id: task.id }));
			run(mutation);
			// Confirmed with the optimistic write, then taken back if either the
			// client run or the server refuses it: never a "Completed" that lies.
			show({
				key: task.id,
				message: m.snackbar_task_completed({ title: task.title }),
				action:
					task.rrule == null
						? { label: m.action_undo(), run: reopen }
						: undefined,
			});
			onMutationFailure(mutation, () =>
				show({
					key: task.id,
					message: m.snackbar_task_complete_failed({ title: task.title }),
				}),
			);
		},
		[run, zero, show, dismissKey],
	);
}
