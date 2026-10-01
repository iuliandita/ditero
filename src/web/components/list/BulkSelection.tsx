import { m } from "../../../paraglide/messages.js";
import type { List, Task } from "../../../zero/schema.gen.ts";
import { useBulkTaskActions } from "../../hooks/useBulkTaskActions.ts";
import { SelectionBar } from "./SelectionBar.tsx";

type Run = (mutation: { client: Promise<unknown> }) => unknown;

// The live count plus the action bar for one surface's selection. `selected`
// arrives in on-screen order and holds only rows that can be written.
export function BulkSelection({
	count,
	selected,
	variant,
	moveTargets,
	allTasks,
	showDueAndPriority,
	run,
	onDone,
}: {
	count: number;
	selected: Task[];
	variant: "tasks" | "shopping";
	moveTargets: List[];
	allTasks: readonly Task[];
	showDueAndPriority: boolean;
	run: Run;
	// Clears the selection; called after actions that end it.
	onDone: () => void;
}) {
	const bulk = useBulkTaskActions(run);
	return (
		<>
			{/* Always mounted while the surface allows selection: a live region
			    inserted together with its text is announced unreliably. */}
			<p
				role="status"
				aria-live="polite"
				aria-atomic
				data-testid="selection-live"
				className="sr-only"
			>
				{count > 0 ? m.selection_count({ count }) : ""}
			</p>
			{count > 0 && (
				<SelectionBar
					count={count}
					variant={variant}
					canComplete={selected.some((t) => !t.done)}
					canUncheck={selected.some((t) => t.done)}
					moveTargets={moveTargets}
					onComplete={() => {
						bulk.complete(selected, variant);
						onDone();
					}}
					onUncheck={
						variant === "shopping"
							? () => {
									bulk.uncheck(selected);
									onDone();
								}
							: undefined
					}
					onMove={(targetId) => {
						const target = moveTargets.find((l) => l.id === targetId);
						if (!target) return;
						bulk.move(
							selected,
							target,
							allTasks.filter((t) => t.listId === target.id),
						);
						onDone();
					}}
					// Due and priority keep the selection for a follow-up edit.
					onDue={
						showDueAndPriority
							? (date, time) => bulk.setDue(selected, date, time)
							: undefined
					}
					onPriority={
						showDueAndPriority
							? (priority) => bulk.setPriority(selected, priority)
							: undefined
					}
					onClearQuantity={
						variant === "shopping"
							? () => bulk.clearQuantity(selected)
							: undefined
					}
					onDelete={() => {
						void bulk.remove(selected).then((done) => {
							if (done) onDone();
						});
					}}
					onClear={onDone}
				/>
			)}
		</>
	);
}
