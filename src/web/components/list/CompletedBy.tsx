import { useQuery, useZero } from "@rocicorp/zero/react";
import { completionAcknowledgement } from "@/lib/completion-acknowledgement";
import { cn } from "@/lib/utils";
import { m } from "../../../paraglide/messages.js";
import { getLocale } from "../../../paraglide/runtime.js";
import { queries } from "../../../zero/queries.ts";
import type { schema, Task } from "../../../zero/schema.gen.ts";
import { useHabitLogs } from "../../hooks/useHabitLogs.ts";

type Props = {
	task: Task;
	done?: boolean;
	habitDate?: string | null;
	completedAt?: number | null;
	className?: string;
	id?: string;
};

export function CompletedBy(props: Props) {
	if (!(props.done ?? props.task.done)) return null;
	return <EligibleCompletion {...props} />;
}

function EligibleCompletion(props: Props) {
	const zero = useZero<typeof schema>();
	const [lists, listDetails] = useQuery(queries.lists.mine());
	const [workspaces, workspaceDetails] = useQuery(queries.workspaces.mine());
	const [memberships, membershipDetails] = useQuery(queries.memberships.mine());
	const list = lists.find((row) => row.id === props.task.listId);
	const workspace = workspaces.find((row) => row.id === list?.workspaceId);
	if (
		listDetails.type !== "complete" ||
		workspaceDetails.type !== "complete" ||
		membershipDetails.type !== "complete" ||
		workspace?.kind !== "shared" ||
		!memberships.some(
			(row) => row.workspaceId === workspace.id && row.userId === zero.userID,
		)
	)
		return null;
	if (props.habitDate != null && props.completedAt === undefined)
		return <HabitCompletion {...props} habitDate={props.habitDate} />;
	const completedAt =
		props.completedAt === undefined
			? props.task.completedAt
			: props.completedAt;
	if (completedAt == null || !Number.isFinite(completedAt)) return null;
	return <CompletionEvent {...props} completedAt={completedAt} />;
}

function HabitCompletion(props: Props & { habitDate: string }) {
	const { logs, loading } = useHabitLogs(props.task.id);
	const log = logs.find((row) => row.date === props.habitDate);
	if (
		loading ||
		log?.status !== "done" ||
		log.completedAt == null ||
		!Number.isFinite(log.completedAt)
	)
		return null;
	return <CompletionEvent {...props} completedAt={log.completedAt} />;
}

function CompletionEvent(props: Props) {
	const zero = useZero<typeof schema>();
	const [events, details] = useQuery(
		queries.taskCompletionEvents.latest({
			taskId: props.task.id,
			habitDate: props.habitDate ?? null,
		}),
	);
	const cue = completionAcknowledgement({
		taskId: props.task.id,
		viewerId: zero.userID,
		shared: true,
		done: props.done ?? props.task.done ?? false,
		completedAt: props.completedAt,
		habitDate: props.habitDate,
		complete: details.type === "complete",
		event: events[0],
	});
	if (!cue) return null;
	const time = m.completion_history_recorded({
		time: new Intl.DateTimeFormat(getLocale(), {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(cue.recordedAt),
	});
	return (
		<span
			id={props.id}
			data-testid="completed-by"
			className={cn(
				"block text-xs text-muted-foreground wrap-anywhere",
				props.className,
			)}
		>
			{m.task_completed_by({ name: `\u2068${cue.name}\u2069` })}
			<span className="sr-only">{` ${time}`}</span>
			<span
				aria-hidden="true"
				className="hidden group-hover/completion:inline group-focus-within/completion:inline"
			>{` · ${time}`}</span>
		</span>
	);
}
