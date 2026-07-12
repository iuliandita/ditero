import { CalendarClock, ChevronRight, Flag } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { formatDue, isOverdue, priorityMeta } from "@/lib/task-display";
import { cn } from "@/lib/utils";
import type { ListKind } from "../../../domain/icon-map.ts";
import type { Label, Task } from "../../../zero/schema.gen.ts";

export type RowHandlers = {
	onToggle: (id: string, done: boolean) => void;
	onOpenDetail: (task: Task) => void;
};

function DueChip({ task }: { task: Task }) {
	if (task.dueAt == null) return null;
	const overdue = isOverdue(task);
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 text-xs",
				overdue ? "text-destructive" : "text-muted-foreground",
			)}
		>
			<CalendarClock className="size-3" />
			{formatDue(task.dueAt, task.dueAllDay)}
		</span>
	);
}

function PriorityFlag({ priority }: { priority: number | null | undefined }) {
	const meta = priorityMeta(priority);
	if (!meta) return null;
	return (
		<Flag
			aria-label={`Priority: ${meta.label}`}
			className={cn("size-3.5 shrink-0 fill-current", meta.color)}
		/>
	);
}

export function TaskRow({
	task,
	kind,
	subtasks,
	labels,
	handlers,
}: {
	task: Task;
	kind: ListKind;
	subtasks: Task[];
	labels: Label[];
	handlers: RowHandlers;
}) {
	const [expanded, setExpanded] = useState(false);
	const bare = kind === "checklist";
	const doneCount = subtasks.filter((s) => s.done).length;
	const total = subtasks.length;
	const progress = total > 0 ? doneCount / total : 0;

	return (
		<div className="rounded-lg">
			<div className="flex items-start gap-2 py-1.5">
				<Checkbox
					aria-label={task.title}
					checked={task.done ?? false}
					onCheckedChange={() => handlers.onToggle(task.id, task.done ?? false)}
					className="mt-0.5"
				/>
				<button
					type="button"
					onClick={() => handlers.onOpenDetail(task)}
					className="min-w-0 flex-1 text-start"
				>
					<span
						className={cn(
							"block truncate",
							task.done && "text-muted-foreground line-through",
						)}
					>
						{task.title}
					</span>
					{!bare && (
						<div className="mt-0.5 flex flex-wrap items-center gap-2">
							<DueChip task={task} />
							{labels.map((l) => (
								<Badge key={l.id} variant="outline" className="h-4 px-1.5">
									{l.name}
								</Badge>
							))}
							{total > 0 && kind !== "project" && (
								<span className="text-xs text-muted-foreground">
									{doneCount}/{total}
								</span>
							)}
						</div>
					)}
					{kind === "project" && total > 0 && (
						<div className="mt-1 flex items-center gap-2">
							<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-kind-project"
									style={{ width: `${Math.round(progress * 100)}%` }}
								/>
							</div>
							<span className="text-xs text-muted-foreground">
								{doneCount}/{total}
							</span>
						</div>
					)}
				</button>
				{!bare && <PriorityFlag priority={task.priority} />}
				{total > 0 && (
					<button
						type="button"
						aria-label={expanded ? "Collapse subtasks" : "Expand subtasks"}
						aria-expanded={expanded}
						onClick={() => setExpanded((e) => !e)}
						className="mt-0.5 text-muted-foreground"
					>
						<ChevronRight
							className={cn(
								"size-4 transition-transform",
								expanded && "rotate-90",
							)}
						/>
					</button>
				)}
			</div>
			{expanded && total > 0 && (
				<ul className="ms-6 flex flex-col border-s ps-2">
					{subtasks.map((s) => (
						<li key={s.id} className="flex items-center gap-2 py-1">
							<Checkbox
								aria-label={s.title}
								checked={s.done ?? false}
								onCheckedChange={() => handlers.onToggle(s.id, s.done ?? false)}
							/>
							<button
								type="button"
								onClick={() => handlers.onOpenDetail(s)}
								className={cn(
									"min-w-0 flex-1 truncate text-start text-sm",
									s.done && "text-muted-foreground line-through",
								)}
							>
								{s.title}
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
