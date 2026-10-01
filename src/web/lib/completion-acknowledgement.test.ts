import { describe, expect, it } from "vitest";
import {
	type CompletionAcknowledgementEvent,
	completionAcknowledgement,
} from "./completion-acknowledgement";

const event: CompletionAcknowledgementEvent = {
	taskId: "task",
	recordedAt: 1000,
	origin: "member_mutation",
	action: "complete",
	habitDate: null,
	afterDone: true,
	actorUserId: "alex",
	actor: { id: "alex", name: "Alex Rivera" },
};
const input = {
	taskId: "task",
	viewerId: "maya",
	shared: true,
	done: true,
	completedAt: 1000,
	complete: true,
	event,
};

describe("completion acknowledgement", () => {
	it("acknowledges another shared member's current completion", () => {
		expect(completionAcknowledgement(input)).toEqual({
			name: "Alex Rivera",
			recordedAt: 1000,
		});
	});
	it.each([
		{ shared: false },
		{ viewerId: "alex" },
		{ viewerId: undefined },
		{ done: false },
		{ completedAt: null },
		{ completedAt: 1001 },
		{ completedAt: Number.NaN },
		{ complete: false },
		{ event: undefined },
	])("omits ineligible or unsynchronized state %j", (change) => {
		expect(completionAcknowledgement({ ...input, ...change })).toBeNull();
	});
	it.each([
		{ taskId: "other" },
		{ origin: "capability_recipient" },
		{ origin: "import" },
		{ action: "reopen", afterDone: false },
		{ action: "skip_occurrence", afterDone: true },
		{ afterDone: false },
		{ habitDate: "2026-10-01" },
		{ actorUserId: "" },
		{ actor: null },
		{ actor: { id: "sam", name: "Alex Rivera" } },
		{ actor: { id: "alex", name: "   " } },
	])("omits unsupported or unknown attribution %j", (change) => {
		expect(
			completionAcknowledgement({ ...input, event: { ...event, ...change } }),
		).toBeNull();
	});
	const habitEvent = {
		...event,
		action: "habit_set",
		habitDate: "2026-10-01",
		afterDone: null,
		afterHabitStatus: "done",
	};
	it("acknowledges the current completed habit date", () => {
		expect(
			completionAcknowledgement({
				...input,
				habitDate: "2026-10-01",
				event: habitEvent,
			}),
		).toEqual({ name: "Alex Rivera", recordedAt: 1000 });
	});
	it.each([
		{ habitDate: "2026-09-30" },
		{ afterHabitStatus: "skipped" },
		{ afterHabitStatus: "pending" },
		{ action: "habit_unlog" },
		{ action: "complete" },
	])("omits a habit with a different date or invalidating transition %j", (change) => {
		expect(
			completionAcknowledgement({
				...input,
				habitDate: "2026-10-01",
				event: { ...habitEvent, ...change },
			}),
		).toBeNull();
	});
});
