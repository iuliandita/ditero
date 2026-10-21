import { describe, expect, test, vi } from "vitest";
import { parseContentProvider } from "./content.ts";
import {
	ContentBuilder,
	type ContentOptions,
	type ContentProvider,
	contentDate,
} from "./content-common.ts";
import { contentBinding } from "./content-input.ts";
import { prepareProviderImportRequest } from "./input.ts";

const options: ContentOptions = {
	exportedAt: "2026-10-21T10:00:00.000Z",
	projectFolderName: "Imported project",
	unsectionedListName: "Unsectioned",
	timezone: "UTC",
	anchorDay: "2026-10-21",
};
const bytes = (text: string) => new TextEncoder().encode(text);
const run = (
	provider: ContentProvider,
	text: string,
	extra: Partial<ContentOptions> = {},
) => parseContentProvider(provider, bytes(text), { ...options, ...extra });
const tasks = (result: Awaited<ReturnType<typeof run>>) =>
	result.document.data.tasks;
const notice = (
	result: Awaited<ReturnType<typeof run>>,
	code: string,
	path?: string,
) =>
	result.notices.find(
		(item) => item.code === code && (path === undefined || item.path === path),
	);
const todoist = (rows: string[], extra: Partial<ContentOptions> = {}) =>
	run(
		"todoist",
		`TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE\n${rows.join("\n")}\n`,
		extra,
	);

describe("P2-1 nested JSON is bounded before native parsing", () => {
	test("millions of nested brackets are rejected immediately with a stable code", async () => {
		const levels = 3_000_000;
		const body = `{"id":"${"a".repeat(24)}","d":${"[".repeat(levels)}${"]".repeat(levels)}}`;
		const started = performance.now();
		await expect(run("trello", body)).rejects.toMatchObject({
			code: "invalid-json",
		});
		expect(performance.now() - started).toBeLessThan(2_000);
	});
	test("brackets inside strings and escapes do not count as nesting", async () => {
		const board = JSON.parse(
			'{"id":"' +
				"a".repeat(24) +
				'","name":"x","lists":[{"id":"' +
				"b".repeat(24) +
				'","name":"L","pos":1}],"cards":[],"checklists":[],"actions":[],"labels":[]}',
		);
		board.name = `${"[".repeat(200)}\\"${"{".repeat(200)}`;
		const result = await run("trello", JSON.stringify(board));
		expect(result.document.data.folders[0]?.name).toBe(board.name);
	});
});

describe("P2-2 archived Trello content", () => {
	const board = (cards: unknown[], lists: unknown[]) =>
		JSON.stringify({
			id: "a".repeat(24),
			name: "Board",
			lists,
			cards,
			checklists: [],
			actions: [],
			labels: [],
		});
	const list = (id: string, closed: boolean) => ({
		id: id.repeat(24),
		name: `List ${id}`,
		pos: 1,
		closed,
	});
	const card = (id: string, idList: string, closed: boolean) => ({
		id: id.repeat(24),
		name: `Card ${id}`,
		idList: idList.repeat(24),
		pos: 1,
		closed,
		desc: "",
		due: null,
		dueComplete: false,
		labels: [],
		idLabels: [],
		idChecklists: [],
	});
	test("archived cards and cards of archived lists import as completed with their own notice", async () => {
		const result = await run(
			"trello",
			board(
				[card("1", "b", false), card("2", "b", true), card("3", "c", false)],
				[list("b", false), list("c", true)],
			),
		);
		expect(
			Object.fromEntries(tasks(result).map((task) => [task.title, task.done])),
		).toEqual({ "Card 1": false, "Card 2": true, "Card 3": true });
		expect(notice(result, "archived-completed", "cards")?.count).toBe(2);
		expect(notice(result, "archive-state", "lists")?.count).toBe(1);
	});
});

describe("P2-3 Todoist date and recurrence grammar", () => {
	const dates = (cell: string, lang = "en", zone = "") =>
		todoist([`task,Item,,1,1,,,"${cell}",${lang},${zone}`]);
	test.each([
		["2026-10-22", "2026-10-22T00:00:00.000Z", true],
		["Oct 22 2026", "2026-10-22T00:00:00.000Z", true],
		["Oct 22", "2026-10-22T00:00:00.000Z", true],
		["22 Oct 2026", "2026-10-22T00:00:00.000Z", true],
		["Thu 22 Oct", "2026-10-22T00:00:00.000Z", true],
		["22 Oct 2026 14:00", "2026-10-22T14:00:00.000Z", false],
		["Oct 22 2026 2:30pm", "2026-10-22T14:30:00.000Z", false],
		["October 22, 2026 at 9am", "2026-10-22T09:00:00.000Z", false],
		["2026-10-22 09:30", "2026-10-22T09:30:00.000Z", false],
	])("absolute date %s survives", async (cell, due, allDay) => {
		const result = await dates(cell);
		expect(tasks(result)[0]).toMatchObject({ dueAt: due, dueAllDay: allDay });
		expect(notice(result, "unsupported-date")).toBeUndefined();
	});
	test("localized month names resolve per DATE_LANG", async () => {
		const result = await dates("22. Okt. 2026", "de");
		expect(tasks(result)[0]?.dueAt).toBe("2026-10-22T00:00:00.000Z");
	});
	test.each([
		["every day", "FREQ=DAILY", "2026-10-21"],
		["every 2 weeks", "FREQ=WEEKLY;INTERVAL=2", "2026-10-21"],
		["every other day", "FREQ=DAILY;INTERVAL=2", "2026-10-21"],
		["every month", "FREQ=MONTHLY", "2026-10-21"],
		["every year", "FREQ=YEARLY", "2026-10-21"],
		["every weekday", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "2026-10-21"],
		["every monday", "FREQ=WEEKLY;BYDAY=MO", "2026-10-26"],
		["every mon, wed", "FREQ=WEEKLY;BYDAY=MO,WE", "2026-10-21"],
		["every month on the 15th", "FREQ=MONTHLY;BYMONTHDAY=15", "2026-11-15"],
		["every last day", "FREQ=MONTHLY;BYMONTHDAY=-1", "2026-10-31"],
		["every jan 31", "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=31", "2027-01-31"],
		["every day starting Oct 25 2026", "FREQ=DAILY", "2026-10-25"],
	])("recurrence %s keeps a rule and an anchored first date", async (cell, rule, day) => {
		const result = await dates(cell);
		expect(tasks(result)[0]).toMatchObject({
			rrule: rule,
			dueAt: `${day}T00:00:00.000Z`,
			dueAllDay: true,
		});
		expect(notice(result, "unsupported-recurrence")).toBeUndefined();
		expect(Boolean(notice(result, "recurrence-anchor", "2026-10-21"))).toBe(
			!cell.includes("starting"),
		);
	});
	test("relative-to-completion, natural-language and localized recurrences are reported, never guessed", async () => {
		const result = await todoist([
			'task,A,,1,1,,,"every! day",en,',
			"task,B,,1,1,,,tomorrow,en,",
			'task,C,,1,1,,,"jeden Montag",de,',
			'task,D,,1,1,,,"every other friday",en,',
		]);
		expect(tasks(result).map((task) => task.rrule)).toEqual([
			null,
			null,
			null,
			null,
		]);
		expect(
			notice(result, "unsupported-recurrence", "row:2:DATE"),
		).toBeDefined();
		expect(notice(result, "unsupported-date", "row:3:DATE")).toBeDefined();
		expect(
			notice(result, "unsupported-recurrence", "row:4:DATE"),
		).toBeDefined();
		expect(
			notice(result, "unsupported-recurrence", "row:5:DATE"),
		).toBeDefined();
	});
	test("a timed recurrence keeps the date but reports the dropped rule", async () => {
		const result = await dates("every day at 9am");
		expect(tasks(result)[0]).toMatchObject({
			rrule: null,
			dueAt: "2026-10-21T09:00:00.000Z",
		});
		expect(notice(result, "timezone-recurrence")).toBeDefined();
	});
});

describe("P2-4 all-day dates use the importer's calendar day", () => {
	const bucharest = { timezone: "Europe/Bucharest" };
	test("a row time zone never shifts a date without a time", async () => {
		const result = await run(
			"generic-csv",
			"title,due,timezone\nA,2026-01-16,Asia/Tokyo\nB,2026-01-16,\nC,2026-01-16T09:00,Asia/Tokyo\n",
			bucharest,
		);
		expect(tasks(result).map((task) => task.dueAt)).toEqual([
			"2026-01-15T22:00:00.000Z",
			"2026-01-15T22:00:00.000Z",
			"2026-01-16T00:00:00.000Z",
		]);
	});
	test("TickTick all-day instants resolve to the day in the task's zone, then anchor to the import zone", async () => {
		const result = await run(
			"ticktick",
			"Folder Name,List Name,Title,Status,taskId,Due Date,Timezone,Is All Day\nHome,Tasks,A,0,a,2026-01-17T23:00:00+0000,Europe/Berlin,true\n",
			bucharest,
		);
		expect(tasks(result)[0]).toMatchObject({
			dueAt: "2026-01-17T22:00:00.000Z",
			dueAllDay: true,
		});
	});
	test.each([
		["Africa/Cairo", "2026-04-24"],
		["Asia/Beirut", "2026-03-29"],
		["America/Santiago", "2026-09-06"],
		["America/Havana", "2026-03-08"],
	])("a day whose midnight does not exist (%s %s) still imports", (zone, day) => {
		const result = contentDate(day, zone);
		expect(result.dueAllDay).toBe(true);
		expect(result.dueAt).not.toBeNull();
		expect(
			new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(
				new Date(result.dueAt ?? 0),
			),
		).toBe(day);
	});
});

describe("P2-5 Outlook date order", () => {
	const csv = (...dates: string[]) =>
		`Subject,Due Date,Status,Notes\n${dates.map((date, i) => `T${i},${date},Not Started,`).join("\n")}\n`;
	test("a day above 12 proves day/month/year", async () => {
		const result = await run("microsoft", csv("13/04/2026", "03/04/2026"), {
			dateOrder: "auto",
		});
		expect(tasks(result).map((task) => task.dueAt)).toEqual([
			"2026-04-13T00:00:00.000Z",
			"2026-04-03T00:00:00.000Z",
		]);
		expect(result.dateOrder).toBe("dmy");
		expect(notice(result, "date-order", "dmy")).toBeDefined();
	});
	test("a month above 12 proves month/day/year", async () => {
		const result = await run("microsoft", csv("04/13/2026"), {
			dateOrder: "auto",
		});
		expect(tasks(result)[0]?.dueAt).toBe("2026-04-13T00:00:00.000Z");
		expect(result.dateOrder).toBe("mdy");
	});
	test("ambiguous dates require an explicit choice that is then bound", async () => {
		await expect(
			run("microsoft", csv("03/04/2026"), { dateOrder: "auto" }),
		).rejects.toMatchObject({ code: "date-order-required" });
		const day = await run("microsoft", csv("03/04/2026"), { dateOrder: "dmy" });
		const month = await run("microsoft", csv("03/04/2026"), {
			dateOrder: "mdy",
		});
		expect(tasks(day)[0]?.dueAt).toBe("2026-04-03T00:00:00.000Z");
		expect(tasks(month)[0]?.dueAt).toBe("2026-03-04T00:00:00.000Z");
		expect(contentBinding(day).dateOrder).toBe("dmy");
	});
	test("mixed orders and a contradicting choice are rejected", async () => {
		await expect(
			run("microsoft", csv("13/04/2026", "04/13/2026"), {
				dateOrder: "auto",
			}),
		).rejects.toMatchObject({ code: "date-order-conflict" });
		await expect(
			run("microsoft", csv("13/04/2026"), { dateOrder: "mdy" }),
		).rejects.toMatchObject({ code: "date-order-conflict" });
	});
	test("the server reparse uses the bound order and rejects a changed claim", async () => {
		const source = csv("03/04/2026");
		const conversion = await run("microsoft", source, { dateOrder: "dmy" });
		const input = {
			...contentBinding(conversion),
			originalBase64: Buffer.from(source).toString("base64"),
		};
		const prepared = await prepareProviderImportRequest(input, options);
		expect(prepared.conversion.document.data.tasks[0]?.dueAt).toBe(
			"2026-04-03T00:00:00.000Z",
		);
		await expect(
			prepareProviderImportRequest({ ...input, dateOrder: "mdy" }, options),
		).rejects.toThrow("metadata-mismatch");
	});
});

describe("P2-7 one bad value does not abort the file", () => {
	test("long titles are shortened to the product limit with a located notice; multibyte titles fit", async () => {
		const result = await run(
			"generic-csv",
			`title\n${"x".repeat(600)}\n${"é".repeat(300)}\nfine\n`,
		);
		expect(tasks(result).map((task) => [...task.title].length)).toEqual([
			500, 300, 4,
		]);
		expect(notice(result, "field-truncated", "row:2:title")).toBeDefined();
		expect(notice(result, "field-truncated", "row:3:title")).toBeUndefined();
	});
	test("rows that cannot be read are skipped with their row number and the rest imports", async () => {
		const result = await run(
			"generic-csv",
			"title,priority\nGood,1\n,2\nBad priority,9\nLast,0\n",
		);
		expect(tasks(result).map((task) => task.title)).toEqual([
			"Good",
			"Bad priority",
			"Last",
		]);
		expect(notice(result, "row-skipped", "row:3")).toBeDefined();
		expect(notice(result, "field-invalid", "row:4:priority")).toBeDefined();
	});
	test("a Todoist row that is only a label is skipped, not fatal", async () => {
		const result = await todoist([
			"task,@home,,1,1,,,,,",
			"task,Keep,,1,1,,,,,",
		]);
		expect(tasks(result).map((task) => task.title)).toEqual(["Keep"]);
		expect(notice(result, "row-skipped", "row:2")).toBeDefined();
	});
	test("verbose Trello cards and comment threads are truncated, not rejected", async () => {
		const id = (n: string) => n.repeat(24);
		const board = {
			id: id("a"),
			name: "B",
			lists: [{ id: id("b"), name: "L", pos: 1 }],
			cards: [
				{
					id: id("c"),
					name: "n".repeat(600),
					desc: "d".repeat(20_000),
					idList: id("b"),
					pos: 1,
				},
			],
			checklists: [
				{ id: id("e"), idCard: id("9"), checkItems: [] },
				{
					id: id("f"),
					idCard: id("c"),
					checkItems: [{ id: id("1"), name: "i", state: "weird", pos: 1 }],
				},
			],
			actions: [1, 2, 3, 4].map((n) => ({
				id: id(String(n)).replace(/^./, "d"),
				type: "commentCard",
				date: `2026-01-0${n}T10:00:00.000Z`,
				data: { card: { id: id("c") }, text: `c${n}${"t".repeat(10_000)}` },
			})),
			labels: [],
		};
		const result = await run("trello", JSON.stringify(board));
		expect([...(tasks(result)[0]?.title ?? "")]).toHaveLength(500);
		expect(notice(result, "field-truncated", "card:1:name")).toBeDefined();
		expect(
			notice(result, "field-truncated", "comment:4:comment"),
		).toBeDefined();
		expect(
			new TextEncoder().encode(tasks(result)[0]?.notes ?? "").byteLength,
		).toBeLessThanOrEqual(32 * 1024 - 1);
		expect(
			notice(result, "unsupported-field", "orphan-checklist"),
		).toBeDefined();
		expect(notice(result, "row-skipped", "item:1")).toBeDefined();
		expect(() => contentBinding(result)).not.toThrow();
	});
	test("TickTick subtasks stay in their parent's list whatever column they name", async () => {
		const result = await run(
			"ticktick",
			"Folder Name,List Name,Title,Status,taskId,parentId,Column Name\nHome,Tasks,Parent,0,p,,Todo\nHome,Tasks,Child,0,c,p,Doing\n",
		);
		expect(result.document.data.lists).toHaveLength(1);
		expect(tasks(result)[1]?.parentId).toBe(tasks(result)[0]?.id);
	});
	test("TickTick rows with empty titles or missing parents are tolerated", async () => {
		const result = await run(
			"ticktick",
			'Folder Name,List Name,Title,Status,taskId,parentId,Content,Is Check list\nHome,Tasks,,0,a,,,N\nHome,Tasks,Child,0,b,a,,N\nHome,Tasks,List,0,c,,"▫\n▪ done",Y\n',
		);
		expect(tasks(result).map((task) => task.title)).toEqual([
			"Child",
			"List",
			"done",
		]);
		expect(tasks(result)[0]?.parentId).toBeNull();
		expect(notice(result, "row-skipped", "row:2")).toBeDefined();
		expect(notice(result, "field-invalid", "row:3:parentId")).toBeDefined();
	});
	test("the CSV error names the failing row", async () => {
		await expect(run("generic-csv", "title\nA\nB,C\n")).rejects.toMatchObject({
			code: "invalid-csv",
			row: 3,
		});
	});
	test("per-row notices stay inside the notice bounds and the binding", async () => {
		const rows = Array.from({ length: 1_500 }, () => "x,y,z").join("\n");
		const result = await run(
			"generic-csv",
			`title,due,completed_at\n${rows}\n`,
		);
		expect(result.notices.length).toBeLessThanOrEqual(512);
		expect(notice(result, "unsupported-date", "more")).toBeDefined();
		expect(() => contentBinding(result)).not.toThrow();
	});
});

describe("P3-1 notice counts saturate at the binding bound", () => {
	test("more than 50,000 repeats of one notice still produce a valid binding", async () => {
		const input = bytes("title\nA\n");
		const builder = new ContentBuilder("generic-csv", {
			...options,
			projectFolderName: "P",
		});
		const list = builder.list("l", "L");
		builder.task({ id: "a", listId: list, title: "A" });
		for (let i = 0; i < 50_005; i++) builder.notice("unsupported-date");
		const result = await builder.finish(input);
		expect(notice(result, "unsupported-date", "export")?.count).toBe(50_000);
		expect(() => contentBinding(result)).not.toThrow();
	}, 60_000);
});

describe("P2-8 TickTick backups as they appear in the wild", () => {
	const header =
		"Folder Name,List Name,Title,Kind,Tags,Content,Is Check list,Start Date,Due Date,Reminder,Repeat,Priority,Status,Created Time,Completed Time,Order,Timezone,Is All Day,Is Floating,Column Name,Column Order,View Mode,taskId,parentId";
	const preamble =
		'"Date: 2026-01-15+0000"\n"Version: 7.1"\n"Status: \n0 Normal\n1 Completed\n2 Archived"\n';
	test("the multi-line Status preamble, ragged rows and stray quotes import what is readable", async () => {
		const result = await run(
			"ticktick",
			`${preamble}${header}\n` +
				'"Home","Tasks","Good","TEXT","","","N","","","","","0","0","","","0","UTC","","false",,,"list","1",""\n' +
				'"Home","Tasks","Extra field, unescaped","TEXT","","","N","","","","","0","0","","","0","UTC","","false",,,"list","2","","surplus"\n' +
				'"Home","Tasks","Short","TEXT"\n' +
				'"Home","Tasks","Bare "quote" inside","TEXT","","","N","","","","","0","0","","","0","UTC","","false",,,"list","4",""\n',
		);
		expect(tasks(result).map((task) => task.title)).toEqual([
			"Good",
			"Short",
			'Bare "quote" inside',
		]);
		expect(notice(result, "row-skipped", "row:6")).toBeDefined();
		expect(notice(result, "row-ragged", "row:7")).toBeDefined();
	});
	test("floating times keep their clock in the import zone", async () => {
		const result = await run(
			"ticktick",
			"Folder Name,List Name,Title,Status,taskId,Due Date,Timezone,Is Floating\nHome,Tasks,A,0,a,2026-01-18T10:00:00+0000,UTC,true\n",
			{ timezone: "Europe/Bucharest" },
		);
		expect(tasks(result)[0]?.dueAt).toBe("2026-01-18T08:00:00.000Z");
	});
});

describe("P3 conversions", () => {
	test("columns holding only false-like values are not reported as lost; real private items are", async () => {
		const result = await run(
			"microsoft",
			"Subject,Reminder On/Off,% Complete,Private,Sensitivity,Status,Notes\nA,False,0%,False,Normal,Not Started,\nB,True,50%,True,Private,Not Started,\n",
			{ dateOrder: "auto" },
		);
		expect(notice(result, "unsupported-field", "Private")).toBeUndefined();
		expect(notice(result, "unsupported-field", "Sensitivity")).toBeUndefined();
		expect(notice(result, "private-items")?.count).toBe(1);
		expect(notice(result, "unsupported-field", "% Complete")?.count).toBe(1);
	});
	test("completion evidence never opens or closes tasks on its own", async () => {
		const result = await run(
			"generic-csv",
			"title,completed,completed_at\nA,false,2026-01-18T09:00:00Z\nB,true,2026-01-18T09:00:00Z\n",
		);
		expect(tasks(result).map((task) => [task.done, task.completedAt])).toEqual([
			[false, null],
			[true, "2026-01-18T09:00:00.000Z"],
		]);
	});
	test("Todoist @labels leave single spaces and no empty unsectioned list", async () => {
		const result = await todoist([
			"section,Only section,,,,,,,,",
			"task,mail bob @acme re: x @acme,,1,1,,,,,",
		]);
		expect(tasks(result)[0]?.title).toBe("mail bob re: x");
		expect(result.document.data.lists.map((list) => list.title)).toEqual([
			"Only section",
		]);
		expect(result.document.data.labels.map((label) => label.color)).toEqual([
			"gray",
		]);
	});
	test("identical rows without an id are distinct tasks", async () => {
		const result = await run(
			"microsoft",
			"Subject,Status,Notes\nBuy milk,Not Started,\nBuy milk,Not Started,\n",
		);
		expect(tasks(result)).toHaveLength(2);
	});
	test("Trello comments read oldest first with their day", async () => {
		const id = (n: string) => n.repeat(24);
		const board = {
			id: id("a"),
			name: "B",
			lists: [{ id: id("b"), name: "L", pos: 1 }],
			cards: [{ id: id("c"), name: "Card", idList: id("b"), pos: 1 }],
			actions: [
				{
					id: id("e"),
					type: "commentCard",
					date: "2026-02-01T10:00:00.000Z",
					data: { card: { id: id("c") }, text: "second" },
				},
				{
					id: id("d"),
					type: "commentCard",
					date: "2026-01-01T10:00:00.000Z",
					data: { card: { id: id("c") }, text: "first" },
				},
			],
		};
		const result = await run("trello", JSON.stringify(board));
		expect(tasks(result)[0]?.notes).toBe(
			"2026-01-01: first\n\n2026-02-01: second",
		);
	});
	test("rotating through every zone reuses cached formatters", async () => {
		const zones = Intl.supportedValuesOf("timeZone").slice(0, 200);
		const rows = zones.map((zone) => `A,2026-01-18T09:00,${zone}`).join("\n");
		const text = `title,due,timezone\n${rows}\n${rows}\n`;
		await run("generic-csv", text);
		const spy = vi.spyOn(Intl, "DateTimeFormat");
		await run("generic-csv", text);
		const created = spy.mock.calls.length;
		spy.mockRestore();
		expect(created).toBeLessThan(10);
	}, 60_000);
});
