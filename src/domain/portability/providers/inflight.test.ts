import { afterEach, describe, expect, test, vi } from "vitest";
import {
	PortableExportValidationError,
	parseBoundedPortableJson,
} from "../validate.ts";
import { ProviderImportError } from "./common.ts";
import { parseContentProvider } from "./content.ts";
import { type ContentOptions, contentJson } from "./content-common.ts";
import { trailingLabels } from "./todoist-content.ts";
import { parseTrelloBoardJson } from "./trello.ts";

const options: ContentOptions = {
	exportedAt: "2026-10-21T10:00:00.000Z",
	projectFolderName: "Imported project",
	unsectionedListName: "Unsectioned",
	timezone: "UTC",
	anchorDay: "2026-10-21",
};
const encoder = new TextEncoder();
const run = (
	provider: Parameters<typeof parseContentProvider>[0],
	text: string,
) => parseContentProvider(provider, encoder.encode(text), options);
const flat = (count: number) => `[${"0,".repeat(count - 1)}0]`;
const BOARD = "a".repeat(24);

afterEach(() => vi.restoreAllMocks());

// Records which side of the native JSON.parse every checkpoint call falls on.
function trace(work: (checkpoint: () => void) => unknown, throwAt = Infinity) {
	const original = JSON.parse;
	let parsed = false;
	vi.spyOn(JSON, "parse").mockImplementation((...args) => {
		parsed = true;
		return original(...(args as [string]));
	});
	const calls: ("pre" | "post")[] = [];
	let error: unknown;
	try {
		work(() => {
			calls.push(parsed ? "post" : "pre");
			if (calls.length >= throwAt) throw new ProviderImportError("timeout");
		});
	} catch (caught) {
		error = caught;
	}
	vi.restoreAllMocks();
	return { calls, parsed, error };
}

describe("request deadlines reach inside bounded JSON parsing", () => {
	test("checkpoints bracket the native parse and the traversal of a tiny document", () => {
		expect(
			trace((checkpoint) => parseBoundedPortableJson("[1]", checkpoint)).calls,
		).toEqual(["pre", "pre", "post", "post"]);
	});
	test("a large flat array is checkpointed while scanned and while traversed", () => {
		const scanned = trace((checkpoint) =>
			parseBoundedPortableJson(flat(400_000), checkpoint),
		);
		expect(
			scanned.calls.filter((phase) => phase === "pre").length,
		).toBeGreaterThan(1_000);
		const traversed = trace((checkpoint) =>
			parseBoundedPortableJson(flat(45_000), checkpoint),
		);
		expect(
			traversed.calls.filter((phase) => phase === "post").length,
		).toBeGreaterThan(80);
	});
	test("a deadline firing during the scan stops before JSON.parse runs", () => {
		const { parsed, error } = trace(
			(checkpoint) => parseBoundedPortableJson(flat(400_000), checkpoint),
			50,
		);
		expect(error).toMatchObject({ code: "timeout" });
		expect(parsed).toBe(false);
	});
	test("a deadline firing right before the native parse stops it", () => {
		const { parsed, error } = trace(
			(checkpoint) => parseBoundedPortableJson("[1]", checkpoint),
			2,
		);
		expect(error).toMatchObject({ code: "timeout" });
		expect(parsed).toBe(false);
	});
	test("a deadline firing during traversal still interrupts", () => {
		const { calls, parsed, error } = trace(
			(checkpoint) => parseBoundedPortableJson(flat(5_000), checkpoint),
			Infinity,
		);
		const firstPost = calls.indexOf("post");
		const again = trace(
			(checkpoint) => parseBoundedPortableJson(flat(5_000), checkpoint),
			firstPost + 3,
		);
		expect(error).toBeUndefined();
		expect(parsed).toBe(true);
		expect(again.error).toMatchObject({ code: "timeout" });
	});
	test("contentJson checkpoints once per traversed value", () => {
		const { calls } = trace((checkpoint) =>
			contentJson(encoder.encode(`{"d":${flat(3_000)}}`), checkpoint),
		);
		expect(calls.length).toBeGreaterThan(3_000);
	});
	test("without a checkpoint the parser behaves as before", () => {
		expect(parseBoundedPortableJson("[1]")).toEqual([1]);
		expect(() => parseBoundedPortableJson("[1")).toThrow(
			PortableExportValidationError,
		);
	});
});

describe("a deadline interrupts Trello parsing of a large flat JSON array", () => {
	// Virtual clock: every performance.now() call advances 1 ms, so the outcome does not
	// depend on host speed.
	function virtualClock() {
		let now = 0;
		vi.spyOn(performance, "now").mockImplementation(() => ++now);
	}
	const board = `{"id":"${BOARD}","name":"B","lists":[],"cards":[],"d":${flat(300_000)}}`;
	test("Trello content import reports the timeout", async () => {
		virtualClock();
		await expect(
			parseContentProvider("trello", encoder.encode(board), {
				...options,
				deadline: 200,
			}),
		).rejects.toMatchObject({ code: "timeout" });
	});
	test("legacy Trello board import reports the timeout", async () => {
		virtualClock();
		await expect(
			parseTrelloBoardJson(encoder.encode(board), {
				exportedAt: options.exportedAt,
				deadline: 200,
			}),
		).rejects.toMatchObject({ code: "timeout" });
	});
});

describe("TickTick folder names and priority prefixes", () => {
	const header = "Folder Name,List Name,Title,Status,taskId,Priority";
	test("a long folder name is shortened with a located notice like other names", async () => {
		const result = await run(
			"ticktick",
			`${header}\n${"F".repeat(600)},Tasks,A,0,a,0\n`,
		);
		expect(result.document.data.folders[0]?.name).toHaveLength(500);
		expect(result.notices).toContainEqual({
			code: "field-truncated",
			path: expect.stringContaining("Folder Name"),
			count: 1,
		});
	});
	test.each([
		["p0", "0"],
		["P1", "1"],
		["p3", "3"],
		["P5", "5"],
	])("priority %s reads as %s", async (given, plain) => {
		const prefixed = await run(
			"ticktick",
			`${header}\nHome,Tasks,A,0,a,${given}\n`,
		);
		const bare = await run(
			"ticktick",
			`${header}\nHome,Tasks,A,0,a,${plain}\n`,
		);
		expect(prefixed.document.data.tasks[0]?.priority).toBe(
			bare.document.data.tasks[0]?.priority,
		);
		expect(prefixed.notices.some((item) => item.code === "field-invalid")).toBe(
			false,
		);
	});
	test.each([
		"p2",
		"pp1",
		"x1",
		"2",
	])("priority %s is still reported as invalid", async (given) => {
		const result = await run(
			"ticktick",
			`${header}\nHome,Tasks,A,0,a,${given}\n`,
		);
		expect(result.notices.some((item) => item.code === "field-invalid")).toBe(
			true,
		);
	});
});

describe("Todoist labels are taken only from the trailing run", () => {
	const head =
		"TYPE,CONTENT,DESCRIPTION,PRIORITY,INDENT,AUTHOR,RESPONSIBLE,DATE,DATE_LANG,TIMEZONE";
	const todoist = (content: string) =>
		run(
			"todoist",
			`${head}\ntask,"${content.replaceAll('"', '""')}",,1,1,,,,,\n`,
		);
	test.each([
		["mail bob @acme re: x", "mail bob @acme re: x", []],
		["fix door @home", "fix door", ["home"]],
		["fix door @home @garage", "fix door", ["home", "garage"]],
		["fix  door   @home    @garage  ", "fix  door", ["home", "garage"]],
		["mail @bob, then @home", "mail @bob, then", ["home"]],
		["email me@home.org", "email me@home.org", []],
		["ping @a then @b now", "ping @a then @b now", []],
		["@home fix door", "@home fix door", []],
	])("%j keeps title %j and labels %j", async (content, title, labels) => {
		const result = await todoist(content);
		expect(result.document.data.tasks[0]?.title).toBe(title);
		expect(result.document.data.labels.map((label) => label.name)).toEqual(
			labels,
		);
	});
	test("a row that is only labels is still skipped", () => {
		expect(trailingLabels("@home @garage")).toEqual({
			title: "",
			labels: ["home", "garage"],
		});
	});
	test("a hostile cell of thousands of labels is split in linear time", () => {
		const content = `${"@a ".repeat(10_000)}!`;
		const started = performance.now();
		expect(trailingLabels(content).labels).toEqual([]);
		expect(performance.now() - started).toBeLessThan(300);
		const long = `title ${"@a ".repeat(10_000)}`;
		expect(trailingLabels(long).labels).toHaveLength(10_000);
		expect(performance.now() - started).toBeLessThan(600);
	});
});
