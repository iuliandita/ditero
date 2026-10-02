export interface CompletionAcknowledgementEvent {
	taskId: string;
	recordedAt: number;
	origin: string;
	action: string;
	habitDate?: string | null;
	afterDone?: boolean | null;
	afterHabitStatus?: string | null;
	actorUserId: string;
	actor?: { id: string; name: string } | null;
}

export function completionAcknowledgement({
	taskId,
	viewerId,
	shared,
	done,
	completedAt,
	habitDate = null,
	complete,
	event,
}: {
	taskId: string;
	viewerId: string | undefined;
	shared: boolean;
	done: boolean;
	completedAt: number | null | undefined;
	habitDate?: string | null;
	complete: boolean;
	event?: CompletionAcknowledgementEvent;
}): { name: string; recordedAt: number } | null {
	if (
		!complete ||
		!shared ||
		!done ||
		!viewerId?.trim() ||
		completedAt == null ||
		!Number.isFinite(completedAt) ||
		!event ||
		event.taskId !== taskId ||
		event.recordedAt !== completedAt ||
		event.origin !== "member_mutation" ||
		!event.actorUserId.trim() ||
		event.actorUserId === viewerId ||
		!event.actor ||
		event.actor.id !== event.actorUserId ||
		!event.actor.name.trim()
	)
		return null;
	if (
		habitDate === null
			? event.habitDate != null ||
				event.action !== "complete" ||
				event.afterDone !== true
			: event.habitDate !== habitDate ||
				event.action !== "habit_set" ||
				event.afterHabitStatus !== "done"
	)
		return null;
	return { name: event.actor.name, recordedAt: event.recordedAt };
}
