import { describe, expect, test } from "vitest";
import { parseContentProvider } from "./content.ts";
import type { ContentOptions, ContentProvider } from "./content-common.ts";

const options: ContentOptions = {
	exportedAt: "2026-01-15T00:00:00.000Z",
	projectFolderName: "Imported project",
	unsectionedListName: "Unsectioned",
	timezone: "Europe/Bucharest",
};
const run = (
	provider: ContentProvider,
	text: string,
	extra: Partial<ContentOptions> = {},
) =>
	parseContentProvider(provider, new TextEncoder().encode(text), {
		...options,
		...extra,
	});

describe("r4 TickTick all-day anchoring", () => {
	const head =
		"Folder Name,List Name,Title,Status,taskId,Due Date,Timezone,Is All Day,Is Floating,Repeat";
	test("a date-only all-day value lands on the import calendar day whatever the row zone", async () => {
		const result = await run(
			"ticktick",
			`${head}\nHome,Tasks,A,0,a,2026-01-16,America/Los_Angeles,true,false,\n`,
		);
		expect(result.document.data.tasks[0]).toMatchObject({
			dueAt: "2026-01-15T22:00:00.000Z",
			dueAllDay: true,
		});
	});
	test("Is All Day wins over Is Floating and keeps the recurrence", async () => {
		const result = await run(
			"ticktick",
			`${head}\nHome,Tasks,A,0,a,2026-01-16T10:00:00+0000,UTC,true,true,every week\n`,
		);
		expect(result.document.data.tasks[0]).toMatchObject({
			dueAt: "2026-01-15T22:00:00.000Z",
			dueAllDay: true,
			rrule: "FREQ=WEEKLY",
		});
	});
});

describe("r4 Outlook impossible numeric dates", () => {
	const csv = (...dates: string[]) =>
		`Subject,Due Date,Status,Notes\n${dates.map((date, i) => `T${i},${date},Not Started,`).join("\n")}\n`;
	test.each([
		"auto",
		"dmy",
	] as const)("one corrupt date is rejected alone with its row (%s)", async (dateOrder) => {
		const result = await run("microsoft", csv("13/04/2026", "04/99/2026"), {
			dateOrder,
		});
		const tasks = result.document.data.tasks;
		expect(tasks.map((task) => task.dueAt)).toEqual([
			"2026-04-12T21:00:00.000Z",
			null,
		]);
		expect(result.dateOrder).toBe("dmy");
		expect(
			result.notices.filter((item) => item.code === "unsupported-date"),
		).toEqual([expect.objectContaining({ path: "row:3:Due Date", count: 1 })]);
	});
	test("an impossible date does not prove an order for ambiguous ones", async () => {
		await expect(
			run("microsoft", csv("31/04/2026", "03/04/2026"), {
				dateOrder: "auto",
			}),
		).rejects.toMatchObject({ code: "date-order-required" });
	});
});
