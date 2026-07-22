// Mutator -> notification seam. Mutators record intent here; they never
// enqueue. notification_outbox is not in drizzle-zero.config.ts, so tx.mutate
// cannot reach it, and a mutator runs on the client too.
//
// This module is deliberately dependency-free (no node builtins, no database)
// because it ships in the client bundle with mutators.ts. On the client no sink
// is installed and every collect is a no-op, which is what keeps the optimistic
// path unaffected. The server installs a request-scoped sink (events.ts) and
// enqueues after the mutation has committed.
export type NotificationEvent =
	| {
			kind: "assign";
			taskId: string;
			taskTitle: string;
			actorUserId: string;
	  }
	| {
			kind: "mention";
			commentId: string;
			taskId: string;
			taskTitle: string;
			actorUserId: string;
	  };

export type PendingEvent = {
	recipientUserId: string;
	event: NotificationEvent;
};

type Sink = (pending: PendingEvent) => void;

let sink: Sink | null = null;

export function setEventSink(next: Sink | null): void {
	sink = next;
}

export function collectEvent(pending: PendingEvent): void {
	sink?.(pending);
}
