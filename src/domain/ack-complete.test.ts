import { describe, expect, it } from "vitest";
import { type AckStore, type AckTask, completeForAck } from "./ack-complete.ts";
import type { CompletionEventInput } from "./completion-history.ts";

// 21:00 in New York -- already the next calendar day in UTC, which is exactly
// where a UTC-framed karma date lands on the wrong day.
const EVENING_NY = Date.UTC(2026, 6, 15, 1, 0, 0);

const PLAIN_TASK: AckTask = {
	id: "t1",
	workspaceId: "w1",
	listKind: "tasks",
	rrule: null,
	recurrenceRelative: false,
	dueAt: null,
	dueAllDay: false,
	done: false,
	priority: 0,
};

function store(
	task: AckTask,
	timeZone: string,
): AckStore & {
	awards: { delta: number; reason: string; date: string }[];
	events: CompletionEventInput[];
} {
	const awards: { delta: number; reason: string; date: string }[] = [];
	const events: CompletionEventInput[] = [];
	return {
		awards,
		events,
		async task() {
			return task;
		},
		async role() {
			return "member";
		},
		async timezone() {
			return timeZone;
		},
		async updateTask() {},
		async habitLog() {
			return null;
		},
		async putHabitLog() {},
		async awardKarma(_userId, delta, reason, date) {
			awards.push({ delta, reason, date });
		},
		async appendEvent(event) {
			events.push(event);
		},
	};
}

describe("completeForAck karma day", () => {
	it("awards task karma against the actor's local day, not UTC", async () => {
		const s = store(PLAIN_TASK, "America/New_York");
		await completeForAck(
			s,
			{ taskId: "t1", occurrenceAt: EVENING_NY, recipientUserId: "u1" },
			"u1",
			"member_mutation",
			EVENING_NY,
		);
		expect(new Date(EVENING_NY).toISOString().slice(0, 10)).toBe("2026-07-15");
		expect(s.awards).toEqual([
			{ delta: 5, reason: "task_complete", date: "2026-07-14" },
		]);
	});

	it("awards habit karma against the same local day", async () => {
		const s = store({ ...PLAIN_TASK, listKind: "habits" }, "America/New_York");
		await completeForAck(
			s,
			{ taskId: "t1", occurrenceAt: EVENING_NY, recipientUserId: "u1" },
			"u1",
			"member_mutation",
			EVENING_NY,
		);
		expect(s.awards).toEqual([
			{ delta: 3, reason: "habit_done", date: "2026-07-14" },
		]);
	});

	it("keeps the UTC day for a UTC user", async () => {
		const s = store(PLAIN_TASK, "UTC");
		await completeForAck(
			s,
			{ taskId: "t1", occurrenceAt: EVENING_NY, recipientUserId: "u1" },
			"u1",
			"member_mutation",
			EVENING_NY,
		);
		expect(s.awards[0].date).toBe("2026-07-15");
	});
});

describe("completeForAck exhausted recurrence", () => {
	it("does not rewrite completion or award Karma on a second ack", async () => {
		const task: AckTask = {
			...PLAIN_TASK,
			rrule: "FREQ=DAILY;COUNT=1",
			dueAt: EVENING_NY,
		};
		const s = store(task, "UTC");
		const updates: { done: boolean; completedAt: number | null }[] = [];
		s.updateTask = async (_id, patch) => {
			task.done = patch.done;
			updates.push({ done: patch.done, completedAt: patch.completedAt });
		};
		const reminder = {
			taskId: task.id,
			occurrenceAt: EVENING_NY,
			recipientUserId: "u1",
		};
		expect(
			await completeForAck(s, reminder, "u1", "member_mutation", EVENING_NY),
		).toBe("completed");
		expect(
			await completeForAck(
				s,
				reminder,
				"u1",
				"member_mutation",
				EVENING_NY + 1_000,
			),
		).toBe("completed");
		expect(updates).toEqual([{ done: true, completedAt: EVENING_NY }]);
		expect(s.awards).toHaveLength(1);
		expect(s.events).toEqual([
			{
				taskId: "t1",
				actorUserId: "u1",
				recordedAt: EVENING_NY,
				origin: "member_mutation",
				action: "complete",
				beforeDueAt: EVENING_NY,
				beforeDueAllDay: false,
				beforeDone: false,
				afterDueAt: EVENING_NY,
				afterDone: true,
			},
		]);
	});
});
