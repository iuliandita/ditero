import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DuePicker } from "./DuePicker.tsx";

function trigger(dueAllDay: boolean) {
	const due = new Date();
	due.setHours(17, 30, 0, 0);
	return renderToStaticMarkup(
		<DuePicker
			dueAt={due.getTime()}
			dueAllDay={dueAllDay}
			done={false}
			onSet={() => {}}
			onClear={() => {}}
		/>,
	);
}

describe("DuePicker summary", () => {
	it("shows the time of a timed due in the value and the accessible name", () => {
		const html = trigger(false);
		expect(html).toMatch(/aria-label="Due date: Today 5:30\sPM"/);
		expect(html).toMatch(/Today 5:30\sPM<\/button>/);
	});

	it("shows only the day for an all-day due", () => {
		const html = trigger(true);
		expect(html).toContain('aria-label="Due date: Today"');
		expect(html).not.toMatch(/5:30/);
	});
});
