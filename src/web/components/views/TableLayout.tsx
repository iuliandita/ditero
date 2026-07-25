import { Flag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatDue, isOverdue, priorityMeta } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import type { Label, Task } from "../../../zero/schema.gen.ts";
import { AssigneeChips } from "../people/AssigneeChips.tsx";
import type { ViewSort } from "./ViewRenderer.tsx";

export type TableEntry = { task: Task; labels: Label[] };

// Only scalar columns are sortable (map onto the view sort fields); multi-value
// columns (Assignees/Labels) and List have no stable single-key sort.
// Thunks: resolving `m` at module scope would freeze the import-time locale.
const SORTABLE: Record<string, () => string> = {
	title: m.field_title,
	due: m.task_field_due,
	priority: m.task_field_priority,
};

function ariaSort(
	field: string,
	sort: ViewSort,
): "ascending" | "descending" | "none" {
	if (sort.field !== field) return "none";
	return sort.dir === "desc" ? "descending" : "ascending";
}

function SortHeader({
	field,
	sort,
	onSort,
}: {
	field: keyof typeof SORTABLE;
	sort: ViewSort;
	onSort: (sort: ViewSort) => void;
}) {
	const active = sort.field === field;
	function toggle() {
		if (active) onSort({ field, dir: sort.dir === "asc" ? "desc" : "asc" });
		else onSort({ field, dir: "asc" });
	}
	return (
		<th scope="col" aria-sort={ariaSort(field, sort)} className="px-3 py-2">
			<button
				type="button"
				onClick={toggle}
				className="flex items-center gap-1 font-medium hover:text-foreground"
			>
				{SORTABLE[field]()}
				{active && (
					<span aria-hidden="true">{sort.dir === "asc" ? "▲" : "▼"}</span>
				)}
			</button>
		</th>
	);
}

export function TableLayout({
	entries,
	sort,
	onSort,
	listTitle,
	onOpenTask,
}: {
	entries: TableEntry[];
	sort: ViewSort;
	onSort: (sort: ViewSort) => void;
	listTitle: (listId: string) => string;
	onOpenTask: (task: Task) => void;
}) {
	return (
		<div className="overflow-x-auto">
			<table className="w-full border-collapse text-start text-sm">
				<thead className="border-b text-start text-xs text-muted-foreground">
					<tr>
						<SortHeader field="title" sort={sort} onSort={onSort} />
						<SortHeader field="due" sort={sort} onSort={onSort} />
						<SortHeader field="priority" sort={sort} onSort={onSort} />
						<th scope="col" className="px-3 py-2 text-start font-medium">
							{m.field_assignees()}
						</th>
						<th scope="col" className="px-3 py-2 text-start font-medium">
							{m.task_field_labels()}
						</th>
						<th scope="col" className="px-3 py-2 text-start font-medium">
							{m.field_list()}
						</th>
					</tr>
				</thead>
				<tbody>
					{entries.map(({ task, labels }) => {
						const meta = priorityMeta(task.priority);
						const overdue = isOverdue(task);
						return (
							<tr key={task.id} className="border-b hover:bg-muted/40">
								<td className="max-w-xs px-3 py-2">
									<button
										type="button"
										onClick={() => onOpenTask(task)}
										className={cn(
											"block max-w-full truncate text-start",
											task.done && "text-muted-foreground line-through",
										)}
									>
										{task.title}
									</button>
								</td>
								<td className="px-3 py-2">
									{task.dueAt == null ? (
										<span className="text-muted-foreground">—</span>
									) : (
										<span className={overdue ? "text-destructive" : undefined}>
											{formatDue(task.dueAt, task.dueAllDay)}
										</span>
									)}
								</td>
								<td className="px-3 py-2">
									{meta ? (
										<span
											className={cn(
												"inline-flex items-center gap-1",
												meta.color,
											)}
										>
											<Flag className="size-3.5 fill-current" />
											{meta.label}
										</span>
									) : (
										<span className="text-muted-foreground">—</span>
									)}
								</td>
								<td className="px-3 py-2">
									<AssigneeChips taskId={task.id} />
								</td>
								<td className="px-3 py-2">
									<div className="flex flex-wrap gap-1">
										{labels.map((l) => (
											<Badge
												key={l.id}
												variant="outline"
												className="h-4 px-1.5"
											>
												{l.name}
											</Badge>
										))}
									</div>
								</td>
								<td className="px-3 py-2 text-muted-foreground">
									{listTitle(task.listId)}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
