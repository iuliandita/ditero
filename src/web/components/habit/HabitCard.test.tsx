import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import type { List, Task } from "../../../zero/schema.gen.ts";
import { HabitCard } from "./HabitCard.tsx";
import { HabitTracker } from "./HabitTracker.tsx";

const state = vi.hoisted(() => ({
	status: "done",
	shared: true,
	actor: "Alice",
	loading: false,
}));
vi.mock("@rocicorp/zero/react", () => ({
	useZero: () => ({ userID: "alice" }),
	useQuery: () => [
		[{ id: "space", kind: state.shared ? "shared" : "personal" }],
		{ type: "complete" },
	],
}));
vi.mock("../../hooks/useHabitLogs.ts", () => ({
	useHabitLogs: () => ({
		loading: state.loading,
		logs: [
			{
				date: "2026-11-05",
				status: state.status,
				completedBy: state.actor ? "alice" : null,
				completer: state.actor ? { id: "alice", name: state.actor } : null,
			},
		],
	}),
}));
vi.mock("../../hooks/useTaskImportActivation.ts", () => ({
	useTaskImportActivation: () => ({ canWrite: true, status: "native" }),
}));
vi.mock("../../hooks/useUserPref.ts", () => ({
	useUserPref: () => ({ pref: { timezone: "UTC" } }),
}));
vi.mock("../task/ReminderChip.tsx", () => ({ ReminderChip: () => null }));

const list: List = {
	id: "list",
	workspaceId: "space",
	ownerId: "alice",
	title: "Habits",
	kind: "habits",
	icon: null,
	folderId: null,
	sortKey: "a0",
	completedDisplay: "sink",
};
const task: Task = {
	id: "habit",
	listId: "list",
	title: "Walk the dog",
	sortKey: "a0",
	createdAt: Date.parse("2026-11-05T00:00:00Z"),
	rrule: "FREQ=DAILY",
	recurrenceAnchorAt: Date.parse("2026-11-05T00:00:00Z"),
	recurrenceConsumed: 0,
	recurrenceRelative: false,
	done: false,
	completedAt: null,
	dueAt: null,
	dueAllDay: true,
	priority: 0,
	notes: null,
	parentId: null,
	quantity: null,
	unit: null,
	category: null,
	reminderTime: null,
	repeatEveryMin: null,
	maxRepeats: null,
	fallbackUserId: null,
	urgent: false,
	hasImportActivation: false,
};

afterEach(() => vi.useRealTimers());

test.each([
	["done", true, "Alice", false, true],
	["skipped", true, "Alice", false, false],
	["done", false, "Alice", false, false],
	["done", true, "", false, false],
	["done", true, "Alice", true, false],
])("habit attribution renders only a known shared completion (%s, %s, %s, loading=%s)", (status, shared, actor, loading, visible) => {
	Object.assign(state, { status, shared, actor, loading });
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
	const html = renderToStaticMarkup(
		<HabitCard task={task} list={list} onOpenDetail={() => {}} />,
	);
	expect(html.includes("Done by")).toBe(visible);
	expect(html).toContain('role="checkbox"');
	expect(html).toContain('data-shape="round"');
	expect(html).toContain('data-kbd-action="toggle"');
	expect(html).toContain('aria-label="Complete Walk the dog today"');
	expect(html).toContain('data-testid="habit-skip"');
	expect(html).toContain("Streak:");
	expect(html).not.toContain("on track");
});

test("history uses actual weekly occurrence endpoints and marks today", () => {
	const html = renderToStaticMarkup(
		<HabitTracker
			today="2026-11-05"
			streak={{
				projectionStatus: "complete",
				current: 1,
				longest: 1,
				adherencePct: 50,
				heatmap: [
					{ date: "2026-10-29", status: "missed" },
					{ date: "2026-11-05", status: "done" },
				],
			}}
		/>,
	);
	expect(html).toContain("Oct 29 to Nov 5");
	expect(html).toContain('aria-current="date"');
	expect(html).toContain(">Today<");
	expect(html).not.toContain("50%");
	const offDay = renderToStaticMarkup(
		<HabitTracker
			today="2026-11-06"
			streak={{
				projectionStatus: "complete",
				current: 1,
				longest: 1,
				adherencePct: 50,
				heatmap: [{ date: "2026-11-05", status: "done" }],
			}}
		/>,
	);
	expect(offDay).not.toContain('aria-current="date"');
	expect(offDay).not.toContain(">Today<");
});
