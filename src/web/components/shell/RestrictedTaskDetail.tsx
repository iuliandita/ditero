import { useZero } from "@rocicorp/zero/react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { runMutation } from "@/lib/run-mutation";
import { formatDue, isOverdue } from "@/lib/task-display";
import { useIsDesktop } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { mutators } from "../../../zero/mutators.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { CommentThread } from "../people/CommentThread.tsx";

// Read-only task detail for the restricted ("kid") shell. The only write a kid may
// perform is completing the task; everything else (title, notes, due, priority,
// labels, subtasks, assignees, move, delete) is display-only or absent. Comments
// are allowed. Deliberately NOT the full TaskDetail, whose management sections a
// kid must never reach.
export function RestrictedTaskDetail({
	task,
	workspaceId,
	open,
	onOpenChange,
}: {
	task: Task | null;
	workspaceId: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const isDesktop = useIsDesktop();
	const zero = useZero<typeof schema>();

	if (!task) return null;
	const t = task;
	const done = t.done ?? false;

	function toggle() {
		void runMutation(
			zero.mutate(
				done
					? mutators.task.update({ id: t.id, done: false })
					: mutators.task.complete({ id: t.id }),
			),
			(msg) => console.error(msg),
		);
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={isDesktop ? "right" : "bottom"}
				data-testid="restricted-detail"
				className={cn("gap-0 overflow-y-auto", !isDesktop && "max-h-[90dvh]")}
			>
				<SheetHeader>
					<SheetTitle
						className={cn(
							"text-lg",
							done && "text-muted-foreground line-through",
						)}
					>
						{t.title}
					</SheetTitle>
				</SheetHeader>

				<div className="flex flex-col gap-4 p-4 pt-2">
					<Button
						type="button"
						size="lg"
						variant={done ? "outline" : "default"}
						data-testid="restricted-detail-toggle"
						aria-pressed={done}
						className="justify-start"
						onClick={toggle}
					>
						<Check />
						{done
							? m.restricted_detail_completed()
							: m.restricted_detail_mark_done()}
					</Button>

					{t.dueAt != null && (
						<div className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{m.restricted_detail_due()}
							</span>
							<span className={cn(isOverdue(t) && !done && "text-destructive")}>
								{formatDue(t.dueAt, t.dueAllDay)}
							</span>
						</div>
					)}

					{t.notes && (
						<div className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">
								{m.restricted_detail_notes()}
							</span>
							<p className="whitespace-pre-wrap break-words">{t.notes}</p>
						</div>
					)}

					<div className="border-t pt-3">
						<CommentThread task={t} workspaceId={workspaceId} restricted />
					</div>
				</div>
			</SheetContent>
		</Sheet>
	);
}
