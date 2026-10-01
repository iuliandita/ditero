import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../zero/schema.gen.ts";
import { habitOccurrence } from "../../views/habit-occurrence.ts";
import { type TableEntry, TableLayout } from "./TableLayout.tsx";

vi.mock("../people/AssigneeChips.tsx", () => ({ AssigneeChips: () => null }));

function task(id: string, dueAt: number): Task {
	return {
		id,
		title: id,
		listId: "list",
		done: false,
		dueAt,
		dueAllDay: true,
	} as Task;
}
function render(entry: TableEntry) {
	return renderToStaticMarkup(
		<TableLayout
			entries={[entry]}
			currentDay="2026-10-01"
			sort={{ field: "due", dir: "asc" }}
			onSort={() => {}}
			listTitle={() => "List"}
			onOpenTask={() => {}}
		/>,
	);
}
afterEach(() => vi.useRealTimers());
describe("TableLayout habit dates", () => {
	it("renders Tokyo's current occurrence day without making it overdue in a UTC browser", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T03:00:00Z"));
		const habit = {
			...task("Habit", Date.parse("2026-09-18T00:00:00Z")),
			rrule: "FREQ=DAILY",
		};
		const occurrence = habitOccurrence(habit, [], new Date(), "Asia/Tokyo");
		expect(occurrence).toMatchObject({
			date: "2026-10-01",
			dueAt: Date.parse("2026-09-30T15:00:00Z"),
			status: "pending",
		});
		const html = render({ task: habit, labels: [], occurrence });
		expect(html).toContain("Oct 1");
		expect(html).not.toContain("text-destructive");
		expect(html).not.toContain("line-through");
	});
	it("retains ordinary task dates and overdue styling", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-01T03:00:00Z"));
		const html = render({
			task: task("Ordinary", Date.parse("2026-09-29T00:00:00Z")),
			labels: [],
		});
		expect(html).toContain("Sep 29");
		expect(html).toContain("text-destructive");
	});
	it("uses occurrence completion and skipped/unavailable status instead of raw task state", () => {
		const raw = task("Habit", Date.parse("2026-09-18T00:00:00Z"));
		const occurrence = {
			date: "2026-10-01",
			dueAt: Date.parse("2026-09-30T15:00:00Z"),
			done: true,
			canToggle: true,
			status: "done" as const,
		};
		expect(render({ task: raw, labels: [], occurrence })).toContain(
			"line-through",
		);
		for (const [status, text] of [
			["skipped", "Skipped this occurrence"],
			[
				"unavailable",
				"Occurrence unavailable. Open the habit to review its schedule.",
			],
		] as const) {
			const html = render({
				task: raw,
				labels: [],
				occurrence: { ...occurrence, done: false, status },
			});
			expect(html).toContain(text);
			expect(html).not.toContain("text-destructive");
		}
	});
});
