import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { projectImportApply } from "../import-apply.ts";
import { buildImportPlan } from "../import-plan.ts";
import { parseContentProvider } from "./content.ts";
import {
	type ContentOptions,
	type ContentProvider,
	contentDate,
} from "./content-common.ts";
import { contentBinding } from "./content-input.ts";
import {
	prepareProviderImportRequest,
	providerDocumentDigest,
} from "./input.ts";

const options: ContentOptions = {
	exportedAt: "2026-01-15T00:00:00.000Z",
	projectFolderName: "Imported project",
	unsectionedListName: "Unsectioned",
	timezone: "UTC",
};
const cases: {
	provider: ContentProvider;
	file: string;
	tasks: number;
	title: string;
	due: string | null;
	done: boolean;
	priority: number;
	labels: string[];
	notes?: string;
}[] = [
	{
		provider: "todoist",
		file: "todoist-content.csv",
		tasks: 5,
		title: "Plan groceries",
		due: "2026-01-16T08:30:00.000Z",
		done: false,
		priority: 3,
		labels: ["household"],
		notes: "Keep the receipt.",
	},
	{
		provider: "ticktick",
		file: "ticktick-backup.csv",
		tasks: 6,
		title: "Return book",
		due: "2026-01-15T17:15:00.000Z",
		done: true,
		priority: 0,
		labels: ["town"],
	},
	{
		provider: "microsoft",
		file: "microsoft-todo-outlook.csv",
		tasks: 2,
		title: "Prepare weekend list",
		due: "2026-01-18T00:00:00.000Z",
		done: false,
		priority: 3,
		labels: ["Household", "Weekend"],
		notes: "Second line",
	},
	{
		provider: "trello",
		file: "trello-content.json",
		tasks: 4,
		title: "Prepare picnic",
		due: "2026-01-18T10:00:00.000Z",
		done: true,
		priority: 0,
		labels: ["Home"],
		notes: "Use reusable cups.",
	},
	{
		provider: "generic-csv",
		file: "generic-tasks.csv",
		tasks: 3,
		title: "=SUM(1,2)",
		due: "2026-01-18T00:00:00.000Z",
		done: false,
		priority: 3,
		labels: ["home", "urgent"],
		notes: "@literal",
	},
];
function fixture(file: string) {
	return readFileSync(
		new URL(
			`../../../../tests/fixtures/portability/providers/${file}`,
			import.meta.url,
		),
	);
}
function bytes(text: string) {
	return new TextEncoder().encode(text);
}
describe("provider content adapters", () => {
	test.each(
		cases,
	)("$provider converts its export fixture and reparses the original bytes through the existing planner", async (item) => {
		const source = fixture(item.file);
		const conversion = await parseContentProvider(
			item.provider,
			source,
			options,
		);
		const { data } = conversion.document;
		expect(data.tasks).toHaveLength(item.tasks);
		const task = data.tasks.find((task) => task.title === item.title);
		expect(task).toMatchObject({
			dueAt: item.due,
			done: item.done,
			priority: item.priority,
		});
		if (item.notes) expect(task?.notes).toContain(item.notes);
		const linked = new Set(
			data.taskLabels
				.filter((link) => link.taskId === task?.id)
				.map((link) => link.labelId),
		);
		expect(
			data.labels
				.filter((label) => linked.has(label.id))
				.map((label) => label.name)
				.sort(),
		).toEqual(item.labels.sort());
		const input = {
			...contentBinding(conversion),
			originalBase64: source.toString("base64"),
		};
		const prepared = await prepareProviderImportRequest(input, options);
		expect(prepared.conversion.document).toEqual(conversion.document);
		expect(prepared.binding).toEqual(contentBinding(conversion));
		const owner = conversion.document.sourceUserId,
			workspace = data.workspaces[0]?.id ?? "";
		const plan = await buildImportPlan(conversion.document, {
			ownerUserId: "owner",
			sourceId: "source",
			mappings: {
				workspaces: { [workspace]: "target" },
				principals: { [owner]: "owner" },
			},
		});
		const projected = projectImportApply(conversion.document, plan.items, {
			plannerVersion: 4,
		});
		expect(
			projected.items.filter(
				(row) => row.collection === "tasks" && row.disposition === "ensure",
			),
		).toHaveLength(item.tasks);
		for (const row of data.tasks)
			expect(row).toMatchObject({
				reminderTime: null,
				repeatEveryMin: null,
				maxRepeats: null,
				fallbackUserId: null,
				urgent: false,
			});
		expect(data.assignments).toEqual([]);
		expect(data.comments).toEqual([]);
		expect(data.attachments).toEqual([]);
		expect(conversion.notices.map((notice) => notice.code)).toEqual(
			expect.arrayContaining([
				"people-excluded",
				"attachments-excluded",
				"reminders-disabled",
				"history-excluded",
			]),
		);
	});
	test("flattens deeper trees, preserves supported recurrence and reports exclusions and duplicates", async () => {
		for (const provider of ["todoist", "ticktick", "generic-csv"] as const) {
			const item = cases.find((item) => item.provider === provider);
			if (!item) throw new Error("Missing fixture");
			const result = await parseContentProvider(
				provider,
				fixture(item.file),
				options,
			);
			const tasks = new Map(
				result.document.data.tasks.map((task) => [task.id, task]),
			);
			for (const task of tasks.values())
				if (task.parentId)
					expect(tasks.get(task.parentId)?.parentId).toBeNull();
			expect(result.notices.map((notice) => notice.code)).toContain(
				"flattened-subtasks",
			);
			expect(
				result.document.data.tasks.some((task) =>
					task.rrule?.startsWith("FREQ="),
				),
			).toBe(true);
		}
		const generic = await parseContentProvider(
			"generic-csv",
			fixture("generic-tasks.csv"),
			options,
		);
		expect(generic.notices).toContainEqual({
			code: "duplicate-row",
			path: "export",
			count: 1,
		});
		expect(generic.notices).toContainEqual({
			code: "unsupported-field",
			path: "estimate",
			count: 2,
		});
	});
	test.each([
		["2026-01-18T09:30", "Europe/Berlin", "2026-01-18T08:30:00.000Z"],
		["2026-07-18T09:30", "Europe/Berlin", "2026-07-18T07:30:00.000Z"],
		["2026-07-18T09:30:00+0530", "UTC", "2026-07-18T04:00:00.000Z"],
	])("resolves explicit local/offset date %s in %s", (value, zone, expected) => {
		expect(contentDate(value, zone).dueAt).toBe(expected);
	});
	test.each([
		"2026-03-29T02:30",
		"2026-10-25T02:30",
		"2026-02-30",
		"2026-01-01T25:00",
	])("reports unresolved date %s without guessing", async (date) => {
		const result = await parseContentProvider(
			"generic-csv",
			bytes(`title,due,timezone\nExample,${date},Europe/Berlin\n`),
			options,
		);
		expect(result.document.data.tasks[0]?.dueAt).toBeNull();
		expect(result.notices.map((notice) => notice.code)).toContain(
			"unsupported-date",
		);
	});
	test.each([
		["malformed quoting", bytes('title\n"unfinished\n'), "invalid-csv"],
		["duplicate headers", bytes("title,title\nA,B\n"), "invalid-csv"],
		["extra column", bytes("title\nA,B\n"), "invalid-csv"],
		["pollution header", bytes("title,__proto__\nA,B\n"), "invalid-csv"],
		["NUL", bytes("title\nA\u0000B\n"), "invalid-row"],
		["invalid UTF-8", new Uint8Array([0xc3, 0x28]), "invalid-encoding"],
		["UTF-16", new Uint8Array([0xff, 0xfe, 0x74, 0x00]), "invalid-encoding"],
		[
			"long field",
			bytes(`title\n${"x".repeat(32 * 1024 + 1)}\n`),
			"field-limit",
		],
		["duplicate ID collision", bytes("id,title\nx,A\nx,B\n"), "invalid-graph"],
		[
			"missing parent",
			bytes("id,parent_id,title\na,missing,Child\n"),
			"invalid-graph",
		],
		[
			"parent cycle",
			bytes("id,parent_id,title\na,b,A\nb,a,B\n"),
			"invalid-graph",
		],
	] as const)("rejects hostile CSV: %s", async (_name, value, code) => {
		await expect(
			parseContentProvider("generic-csv", value, options),
		).rejects.toMatchObject({ code });
	});
	test("accepts UTF-8 BOM and literal formula text while refusing polluted JSON and changed metadata", async () => {
		const raw = bytes('\ufefftitle,notes\n"=1+1","@literal"\n');
		const result = await parseContentProvider("generic-csv", raw, options);
		expect(result.document.data.tasks[0]).toMatchObject({
			title: "=1+1",
			notes: "@literal",
		});
		const input = {
			...contentBinding(result),
			originalBase64: Buffer.from(raw).toString("base64"),
		};
		await expect(
			prepareProviderImportRequest({ ...input, notices: [] }, options),
		).rejects.toThrow("metadata-mismatch");
		await expect(
			prepareProviderImportRequest(
				{ ...input, snapshotSha256: "0".repeat(64) },
				options,
			),
		).rejects.toThrow();
		const polluted = fixture("trello-content.json")
			.toString()
			.replace(
				'"name": "Household board"',
				'"name": "Household board", "__proto__": {"polluted":true}',
			);
		await expect(
			parseContentProvider("trello", bytes(polluted), options),
		).rejects.toMatchObject({ code: "invalid-json" });
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
		const digest = await providerDocumentDigest(
			contentBinding(result),
			"a".repeat(64),
		);
		expect(digest).not.toBe(
			await providerDocumentDigest(
				{ ...contentBinding(result), timezone: "Europe/Berlin" },
				"a".repeat(64),
			),
		);
	});
	test.each([
		["missing-list", "invalid-graph"],
		["single-invalid-position", "invalid-row"],
		["conflicting-card", "invalid-graph"],
		["duplicate-label", "invalid-graph"],
		["foreign-checklist", "invalid-graph"],
		["conflicting-comment", "invalid-graph"],
	])("rejects hostile Trello references and shapes: %s", async (kind, code) => {
		const board = JSON.parse(fixture("trello-content.json").toString());
		if (kind === "missing-list") board.cards[0].idList = "9".repeat(24);
		if (kind === "single-invalid-position") {
			board.cards = [board.cards[0]];
			board.cards[0].pos = "123";
		}
		if (kind === "conflicting-card")
			board.cards.push({ ...board.cards[0], desc: "changed" });
		if (kind === "duplicate-label")
			board.labels.push({ ...board.labels[0], name: "conflict" });
		if (kind === "foreign-checklist")
			board.checklists[0].idBoard = "9".repeat(24);
		if (kind === "conflicting-comment")
			board.actions.push({
				...board.actions[0],
				data: { ...board.actions[0].data, text: "changed" },
			});
		await expect(
			parseContentProvider("trello", bytes(JSON.stringify(board)), options),
		).rejects.toMatchObject({ code });
	});
	test("preserves local fractional seconds and reports note-row fields instead of silently discarding them", async () => {
		expect(contentDate("2026-07-18T09:30:00.123", "Europe/Berlin").dueAt).toBe(
			"2026-07-18T07:30:00.123Z",
		);
		const value = bytes(
			"TYPE,CONTENT,DESCRIPTION,DATE\ntask,Example,,\nnote,Comment,Separate note description,2026-01-01\n",
		);
		const result = await parseContentProvider("todoist", value, options);
		expect(result.document.data.tasks[0]?.notes).toBe("Comment");
		expect(result.notices).toContainEqual({
			code: "unsupported-field",
			path: "DESCRIPTION",
			count: 1,
		});
		expect(result.notices).toContainEqual({
			code: "unsupported-field",
			path: "DATE",
			count: 1,
		});
	});
	test("rejects hidden TickTick preamble records and conflicting native IDs", async () => {
		const original = fixture("ticktick-backup.csv");
		await expect(
			parseContentProvider(
				"ticktick",
				Buffer.concat([Buffer.from("Hidden task,ignored\n"), original]),
				options,
			),
		).rejects.toThrow("invalid-csv");
		const text = original
			.toString()
			.replace("cupboard,kitchen", "kitchen,kitchen");
		expect(text).not.toBe(original.toString());
		await expect(
			parseContentProvider("ticktick", bytes(text), options),
		).rejects.toThrow("invalid-graph");
	});
	test.each([
		"FREQ=DAILY;INTERVAL=0",
		"FREQ=DAILY;INTERVAL=-1",
		"FREQ=DAILY;COUNT=0",
		"FREQ=DAILY;BYHOUR=12",
		"FREQ=DAILY;FREQ=SECONDLY",
	])("reports unsafe or timed recurrence instead of importing it: %s", async (rule) => {
		const result = await parseContentProvider(
			"generic-csv",
			bytes(`title,due,recurrence\nExample,2026-01-18,${rule}\n`),
			options,
		);
		expect(result.document.data.tasks[0]?.rrule).toBeNull();
		expect(result.notices.map((item) => item.code)).toContain(
			"unsupported-recurrence",
		);
	});
	test("TickTick archived and won't-do tasks are finished work, not open tasks", async () => {
		const result = await parseContentProvider(
			"ticktick",
			bytes(
				"Folder Name,List Name,Title,Status,taskId,Completed Time\nHome,Tasks,Archived,2,a,\nHome,Tasks,Archived complete,2,b,2026-01-18T09:00:00Z\nHome,Tasks,Wont do,-1,c,\nHome,Tasks,Open,0,d,2026-01-18T09:00:00Z\n",
			),
			options,
		);
		expect(
			result.document.data.tasks.map((task) => [task.done, task.completedAt]),
		).toEqual([
			[true, null],
			[true, "2026-01-18T09:00:00.000Z"],
			[true, null],
			[false, null],
		]);
		expect(result.notices).toContainEqual({
			code: "archived-completed",
			path: "row:2:Status",
			count: 1,
		});
	});
	test("Microsoft progress states are explicit exclusions rather than silent open-state conversion", async () => {
		const result = await parseContentProvider(
			"microsoft",
			bytes("Subject,Status,Notes\nExample,In Progress,Working on it\n"),
			options,
		);
		expect(result.document.data.tasks[0]).toMatchObject({
			done: false,
			notes: "Working on it",
		});
		expect(result.notices).toContainEqual({
			code: "unsupported-field",
			path: "Status",
			count: 1,
		});
	});
	test("honors byte bounds, cancellation and deadlines before conversion", async () => {
		await expect(
			parseContentProvider(
				"generic-csv",
				new Uint8Array(32 * 1024 * 1024 + 1),
				options,
			),
		).rejects.toThrow("byte-limit");
		await expect(
			parseContentProvider("generic-csv", bytes("title\nA\n"), {
				...options,
				signal: AbortSignal.abort(),
			}),
		).rejects.toThrow("cancelled");
		await expect(
			parseContentProvider("generic-csv", bytes("title\nA\n"), {
				...options,
				deadline: performance.now() - 1,
			}),
		).rejects.toThrow("timeout");
	});
});
