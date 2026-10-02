import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../zero/schema.gen.ts";
import { CalendarLayout } from "./CalendarLayout.tsx";
import type { ViewEntry } from "./ViewRenderer.tsx";

vi.mock("../list/CompletedBy.tsx", () => ({ CompletedBy: () => null }));

function entry(id: string, date: string): ViewEntry {
	return {
		task: {
			id,
			title: id,
			listId: "list",
			done: false,
			dueAt: Date.parse(`${date}T12:00:00Z`),
			dueAllDay: true,
			rrule: null,
		} as Task,
		kind: "tasks",
		labels: [],
		listTitle: "Personal list",
		listIcon: null,
		sourceContext: "Home · Personal",
	};
}
function render(
	entries: ViewEntry[],
	isDesktop = false,
	habitOccurrenceOnly = false,
) {
	return renderToStaticMarkup(
		<CalendarLayout
			entries={entries}
			isDesktop={isDesktop}
			onOpenTask={() => {}}
			onReschedule={() => {}}
			canDrag={() => false}
			timeZone="UTC"
			habitOccurrenceOnly={habitOccurrenceOnly}
		/>,
	);
}
afterEach(() => vi.useRealTimers());
describe("CalendarLayout", () => {
	it("renders phone month navigation and a current-day entry point before today's work", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
		const html = render([
			entry("earlier", "2026-09-01"),
			entry("spillover", "2026-08-31"),
			entry("current", "2026-09-30"),
		]);
		expect(html).toContain('data-testid="calendar-prev"');
		expect(html).toContain('data-testid="calendar-next"');
		expect(html).toContain('data-testid="calendar-today"');
		expect(html).toContain("September 2026");
		expect(html).toContain('data-testid="calendar-earlier"');
		expect(html).toContain("current");
		expect(html).toContain("Home · Personal");
		expect(html).not.toContain(">earlier<");
		expect(html).not.toContain(">spillover<");
		expect(html.match(/data-testid="agenda-item"/g)).toHaveLength(1);
	});
	it("shows one completed habit occurrence under an explicit completion filter", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-30T12:00:00Z"));
		const habit = entry("Read", "2026-09-18");
		habit.kind = "habits";
		habit.task = { ...habit.task, rrule: "FREQ=DAILY" };
		habit.occurrence = {
			date: "2026-09-30",
			dueAt: Date.parse("2026-09-30T00:00:00Z"),
			done: true,
			canToggle: true,
			status: "done",
		};
		const html = render([habit], true, true);
		expect(html.match(/data-testid="calendar-chip"/g)).toHaveLength(1);
		expect(html.match(/data-testid="agenda-item"/g)).toHaveLength(1);
		expect(html).toContain("line-through");
		expect(html).toContain("Done");
	});
});
