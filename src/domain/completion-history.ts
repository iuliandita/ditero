export const COMPLETION_HISTORY_PAGE_SIZE = 100;

export type CompletionOrigin = "member_mutation" | "capability_recipient";
export type HabitHistoryStatus = "done" | "skipped";

type EventBase = {
	taskId: string;
	actorUserId: string;
	recordedAt: number;
	origin: CompletionOrigin;
};

export type CompletionEventInput = EventBase &
	(
		| {
				action: "complete" | "reopen" | "skip";
				beforeDueAt: number | null;
				beforeDueAllDay: boolean;
				beforeDone: boolean;
				afterDueAt: number | null;
				afterDone: boolean;
		  }
		| {
				action: "habit_set" | "habit_unlog";
				habitDate: string;
				beforeHabitStatus: HabitHistoryStatus | null;
				afterHabitStatus: HabitHistoryStatus | null;
		  }
	);

export type AppendCompletionEvent = (
	event: CompletionEventInput,
) => Promise<void>;
