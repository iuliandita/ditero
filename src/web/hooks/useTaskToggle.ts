import { useZero } from "@rocicorp/zero/react";
import { useCallback } from "react";
import { m } from "../../paraglide/messages.js";
import { mutators } from "../../zero/mutators.ts";
import type { schema, Task } from "../../zero/schema.gen.ts";
import { useSnackbar } from "../components/ui/snackbar.tsx";

type Run = (mutation: { client: Promise<unknown> }) => unknown;

// Check/uncheck a row and confirm a completion in the shared snackbar. The
// snackbar is raised together with the optimistic write, never after the
// server answers. Undo reopens through the same task.update the uncheck path
// already uses. A recurring task gets no Undo: task.complete advanced its due
// date to the next occurrence, and reopening would not restore that.
export function useTaskToggle(run: Run) {
	const zero = useZero<typeof schema>();
	const snackbar = useSnackbar();
	return useCallback(
		(task: Pick<Task, "id" | "title" | "done" | "rrule">) => {
			const reopen = () =>
				run(zero.mutate(mutators.task.update({ id: task.id, done: false })));
			if (task.done) {
				reopen();
				return;
			}
			run(zero.mutate(mutators.task.complete({ id: task.id })));
			snackbar({
				message: m.snackbar_task_completed({ title: task.title }),
				action:
					task.rrule == null
						? { label: m.action_undo(), run: reopen }
						: undefined,
			});
		},
		[run, zero, snackbar],
	);
}
