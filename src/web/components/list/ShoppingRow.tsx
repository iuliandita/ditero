import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import type { Task } from "../../../zero/schema.gen.ts";

export type ShoppingHandlers = {
	onToggle: (id: string, done: boolean) => void;
	onOpenDetail: (task: Task) => void;
	onUpdate: (id: string, patch: { quantity?: string; unit?: string }) => void;
};

// Commit only on real change so a blur without edits does not fire a mutation.
function commit(
	current: string | null | undefined,
	next: string,
	apply: (v: string) => void,
) {
	const trimmed = next.trim();
	if (trimmed !== (current ?? "")) apply(trimmed);
}

export function ShoppingRow({
	task,
	handlers,
}: {
	task: Task;
	handlers: ShoppingHandlers;
}) {
	return (
		<div className="flex items-center gap-2 py-1.5">
			<Checkbox
				aria-label={task.title}
				checked={task.done ?? false}
				onCheckedChange={() => handlers.onToggle(task.id, task.done ?? false)}
			/>
			<button
				type="button"
				onClick={() => handlers.onOpenDetail(task)}
				className={cn(
					"min-w-0 flex-1 truncate text-start",
					task.done && "text-muted-foreground line-through",
				)}
			>
				{task.title}
			</button>
			<input
				// key resets the field when the synced value changes underneath.
				key={`q-${task.quantity ?? ""}`}
				defaultValue={task.quantity ?? ""}
				aria-label={m.shopping_quantity_for({ title: task.title })}
				placeholder={m.shopping_qty_placeholder()}
				inputMode="decimal"
				className="h-7 w-12 rounded-md border bg-transparent px-1.5 text-center text-sm"
				onBlur={(e) =>
					commit(task.quantity, e.target.value, (v) =>
						handlers.onUpdate(task.id, { quantity: v }),
					)
				}
			/>
			<input
				key={`u-${task.unit ?? ""}`}
				defaultValue={task.unit ?? ""}
				aria-label={m.shopping_unit_for({ title: task.title })}
				placeholder={m.shopping_unit_placeholder()}
				className="h-7 w-14 rounded-md border bg-transparent px-1.5 text-sm"
				onBlur={(e) =>
					commit(task.unit, e.target.value, (v) =>
						handlers.onUpdate(task.id, { unit: v }),
					)
				}
			/>
		</div>
	);
}
