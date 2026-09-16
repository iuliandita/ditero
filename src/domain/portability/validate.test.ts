import { describe, expect, test } from "vitest";
import type { PortableExportV1 } from "./v1.ts";
import {
	PortableExportValidationError,
	parsePortableExportV1,
} from "./validate.ts";

const stamp = "2026-09-16T10:00:00.000Z";

function fixture(): PortableExportV1 {
	return {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: stamp,
		sourceUserId: "user",
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "current-state-and-habit-logs",
		},
		data: {
			principals: [{ id: "user", name: "Reader" }],
			workspaces: [
				{ id: "workspace", name: "Home", ownerId: "user", kind: "shared" },
			],
			memberships: [
				{
					id: "membership",
					userId: "user",
					workspaceId: "workspace",
					role: "owner",
				},
			],
			folders: [
				{
					id: "folder",
					workspaceId: "workspace",
					name: "Folder",
					sortKey: "a",
				},
			],
			lists: [
				{
					id: "list",
					workspaceId: "workspace",
					ownerId: "user",
					title: "Habits",
					kind: "habits",
					icon: null,
					folderId: "folder",
					sortKey: "a",
					completedDisplay: "sink",
				},
			],
			tasks: [
				{
					id: "task",
					listId: "list",
					title: "Walk",
					done: false,
					notes: "Keep all the text",
					dueAt: stamp,
					dueAllDay: false,
					priority: 2,
					completedAt: null,
					sortKey: "a",
					parentId: null,
					quantity: null,
					unit: null,
					category: null,
					rrule: "FREQ=DAILY",
					recurrenceRelative: false,
					reminderTime: "09:00",
					repeatEveryMin: null,
					maxRepeats: null,
					fallbackUserId: null,
					urgent: false,
				},
			],
			labels: [
				{ id: "label", workspaceId: "workspace", name: "Home", color: "green" },
			],
			taskLabels: [{ id: "task-label", taskId: "task", labelId: "label" }],
			templates: [
				{
					id: "template",
					workspaceId: "workspace",
					kind: "task",
					name: "Walk",
					icon: null,
					content: {
						kind: "task",
						task: {
							title: "Walk",
							notes: "Description",
							subtasks: [{ title: "Get shoes" }],
						},
					},
					createdBy: "user",
				},
			],
			assignments: [{ id: "assignment", taskId: "task", userId: "user" }],
			comments: [
				{
					id: "comment",
					taskId: "task",
					authorId: "user",
					body: "Go outside",
					createdAt: stamp,
					editedAt: null,
				},
			],
			habitLogs: [
				{
					id: "log",
					habitId: "task",
					date: "2024-02-29",
					status: "done",
					karmaDelta: 3,
					completedAt: stamp,
					createdAt: stamp,
				},
			],
			views: [
				{
					id: "view",
					ownerId: "user",
					workspaceId: null,
					name: "Today",
					icon: null,
					scope: "personal",
					filter: {
						op: "and",
						conditions: [
							{ field: "due", operator: "after", value: "2024-02-29" },
						],
					},
					display: {
						layout: "list",
						groupBy: "none",
						sort: { field: "sortKey", dir: "asc" },
						workspaceScope: { mode: "all" },
					},
					sortKey: "a",
					createdAt: stamp,
					updatedAt: stamp,
				},
			],
			dashboards: [
				{
					id: "dashboard",
					ownerId: "user",
					workspaceId: "workspace",
					scope: "workspace",
					name: "Summary",
					icon: null,
					panels: [
						{
							id: "panel",
							type: "tasks",
							size: "m",
							source: {
								kind: "inline",
								filter: {
									op: "and",
									conditions: [{ field: "done", operator: "is", value: false }],
								},
								sort: { field: "priority", dir: "desc" },
								workspaceScope: { mode: "one", id: "workspace" },
							},
						},
					],
					sortKey: "a",
					createdAt: stamp,
					updatedAt: stamp,
				},
			],
			userPrefs: [
				{
					id: "user",
					keymap: { "task.complete": [["x"]] },
					keymapProfile: "default",
					homeViewRef: "view",
					pinnedViews: ["view"],
					karmaGoals: { daily: 5, weekly: 25 },
					vacation: { active: true, until: "2024-02-29" },
					focus: {
						workMin: 25,
						breakMin: 5,
						longBreakMin: 15,
						roundsPerLongBreak: 4,
						autoCycle: false,
					},
					timezone: "Europe/Berlin",
					quietHours: { start: "22:00", end: "07:00" },
					escalationDefaults: {
						repeatEveryMin: 5,
						maxRepeats: 3,
						fallbackUserId: null,
					},
					locale: "ro",
					theme: "dark",
					e2eAutoLockMinutes: 15,
					createdAt: stamp,
					updatedAt: stamp,
				},
			],
			focusSessions: [
				{
					id: "focus",
					userId: "user",
					taskId: "task",
					kind: "work",
					startedAt: stamp,
					endedAt: "2026-09-16T10:00:10.000Z",
					durationSec: 10,
					createdAt: stamp,
				},
			],
			karma: [{ userId: "user", points: 3, level: 1, updatedAt: stamp }],
			karmaEvents: [
				{
					id: "karma-event",
					userId: "user",
					date: "2024-02-29",
					delta: 3,
					reason: "habit",
					createdAt: stamp,
				},
			],
			attachments: [
				{
					id: "attachment",
					workspaceId: "workspace",
					parentKind: "task",
					parentId: "task",
					keyVersion: 1,
					declaredBytes: 42,
					observedBytes: 42,
					ciphertextSha256: "a".repeat(64),
					thumbnailDeclaredBytes: null,
					thumbnailObservedBytes: null,
					thumbnailCiphertextSha256: null,
					uploadedBy: "user",
					createdAt: stamp,
					committedAt: stamp,
				},
			],
		},
	};
}

function parse(value: unknown) {
	return parsePortableExportV1(JSON.stringify(value));
}

describe("portable v1 validation", () => {
	test("accepts reordered object keys throughout the document", () => {
		const value = fixture();
		function reorder(item: unknown): unknown {
			if (Array.isArray(item)) return item.map(reorder);
			if (item && typeof item === "object")
				return Object.fromEntries(
					Object.entries(item)
						.reverse()
						.map(([key, child]) => [key, reorder(child)]),
				);
			return item;
		}
		expect(parse(reorder(value))).toEqual(value);
	});

	test("reports stable errors without copying unknown keys or input values", () => {
		const value = fixture();
		Object.assign(value, { "PRIVATE-TASK-CONTENT": "PRIVATE-COMMENT" });
		for (const input of [JSON.stringify(value), '{"PRIVATE-TASK-CONTENT":']) {
			try {
				parsePortableExportV1(input);
				throw new Error("Expected rejection");
			} catch (error) {
				expect(error).toBeInstanceOf(PortableExportValidationError);
				expect(String(error)).not.toContain("PRIVATE-");
				expect(JSON.stringify(error)).not.toContain("PRIVATE-");
			}
		}
	});
	test("preserves every valid collection and nested value", () => {
		const input = fixture();
		expect(Object.values(input.data).every((rows) => rows.length > 0)).toBe(
			true,
		);
		expect(parse(input)).toEqual(input);
	});

	test("accepts nullable preferences, exported extended years, and existing smallint priorities", () => {
		const input = fixture();
		Object.assign(input.data.userPrefs[0], {
			karmaGoals: null,
			vacation: null,
			focus: null,
			quietHours: null,
			escalationDefaults: null,
			locale: null,
			theme: null,
			e2eAutoLockMinutes: null,
		});
		Object.assign(input.data.tasks[0], {
			priority: -32768,
			dueAt: "+010000-01-01T00:00:00.000Z",
		});
		expect(parse(input)).toEqual(input);
	});

	test.each([
		"format",
		"schemaVersion",
		"boundaries",
		"data",
	])("rejects missing required %s", (key) => {
		const input = fixture();
		Reflect.deleteProperty(input, key);
		expect(() => parse(input)).toThrow();
	});

	test("rejects unsupported format/version and top-level or collection keys", () => {
		for (const change of [
			(value: PortableExportV1) => Object.assign(value, { schemaVersion: 2 }),
			(value: PortableExportV1) => Object.assign(value, { format: "other" }),
			(value: PortableExportV1) => Object.assign(value, { token: "extra" }),
			(value: PortableExportV1) =>
				Object.assign(value.boundaries, { credentials: "included" }),
			(value: PortableExportV1) => Object.assign(value.data, { sessions: [] }),
		]) {
			const value = fixture();
			change(value);
			expect(() => parse(value)).toThrow();
		}
	});

	test("requires exact row keys in all nineteen collections", () => {
		for (const key of Object.keys(
			fixture().data,
		) as (keyof PortableExportV1["data"])[]) {
			const extra = fixture();
			Object.assign(extra.data[key][0] ?? {}, { extra: "unrecognized" });
			expect(() => parse(extra), key).toThrow();
			const missing = fixture();
			const row = missing.data[key][0];
			if (!row) throw new Error("Missing fixture row");
			Reflect.deleteProperty(row, Object.keys(row)[0] ?? "id");
			expect(() => parse(missing), key).toThrow();
		}
	});

	test.each([
		"2026-02-29T10:00:00.000Z",
		"2026-13-01T00:00:00.000Z",
		"2026-09-16",
		"2026-09-16T25:00:00.000Z",
		"invalid",
	])("rejects invalid timestamp %s", (exportedAt) => {
		expect(() => parse({ ...fixture(), exportedAt })).toThrow();
	});

	test("rejects nonexistent days, invalid enums, numeric bounds, and focus intervals", () => {
		for (const [collection, update] of [
			["habitLogs", { date: "2023-02-29" }],
			["karmaEvents", { date: "2026-04-31" }],
			["memberships", { role: "superuser" }],
			["workspaces", { kind: "group" }],
			["lists", { kind: "unknown" }],
			["lists", { completedDisplay: "remove" }],
			["habitLogs", { status: "pending" }],
			["tasks", { priority: 32768 }],
			["tasks", { reminderTime: "24:00" }],
			["tasks", { maxRepeats: 21 }],
			["attachments", { parentKind: "workspace" }],
			["attachments", { keyVersion: 0 }],
			["attachments", { declaredBytes: 1.5 }],
			["attachments", { ciphertextSha256: "abc" }],
			["focusSessions", { endedAt: "2026-09-16T09:00:00.000Z" }],
			["focusSessions", { durationSec: 100 }],
		] as const) {
			const value = fixture();
			Object.assign(value.data[collection][0] ?? {}, update);
			expect(() => parse(value), JSON.stringify(update)).toThrow();
		}
	});

	test.each([
		{ field: "done", operator: "is", value: "false" },
		{ field: "done", operator: "eq", value: false },
		{ field: "priority", operator: "contains", value: 1 },
		{ field: "kind", operator: "in", value: ["tasks", 1] },
		{ field: "list", operator: "in", value: "list" },
		{ field: "due", operator: "is", value: "tomorrow" },
		{ field: "due", operator: "before", value: "2025-02-29" },
		{ field: "assignee", operator: "includes", value: ["user"] },
	])("rejects invalid filter condition $field/$operator in views and inline panels", (condition) => {
		const value = fixture();
		const filter = { op: "and", conditions: [condition] };
		Object.assign(value.data.views[0] ?? {}, { filter });
		expect(() => parse(value)).toThrow();
		const dashboard = fixture();
		Object.assign(dashboard.data.dashboards[0] ?? {}, {
			panels: [
				{
					id: "panel",
					type: "counter",
					size: "s",
					source: {
						kind: "inline",
						filter,
						sort: { field: "priority", dir: "asc" },
						workspaceScope: { mode: "all" },
					},
				},
			],
		});
		expect(() => parse(dashboard)).toThrow();
	});

	test("refuses nested unknown fields rather than stripping or adding defaults", () => {
		for (const [collection, update] of [
			[
				"templates",
				{
					content: { kind: "task", task: { title: "Task", secret: "unknown" } },
				},
			],
			[
				"templates",
				{ content: { kind: "list", listKind: "tasks", tasks: [] } },
			],
			["views", { filter: { op: "and", conditions: [], secret: "unknown" } }],
			["views", { display: { layout: "list" } }],
			[
				"dashboards",
				{ panels: [{ id: "panel", type: "focus", size: "s", range: "year" }] },
			],
			[
				"userPrefs",
				{
					focus: {
						workMin: 25,
						breakMin: 5,
						longBreakMin: 15,
						roundsPerLongBreak: 4,
						autoCycle: false,
						extra: true,
					},
				},
			],
		] as const) {
			const value = fixture();
			Object.assign(value.data[collection][0] ?? {}, update);
			expect(() => parse(value)).toThrow();
		}
	});

	test("validates preferences against the write contract", () => {
		for (const update of [
			{ timezone: "Not/A_Timezone" },
			{ locale: "zz" },
			{ e2eAutoLockMinutes: 7 },
			{ keymapProfile: "emacs" },
			{ keymap: { command: [["x", "y", "z", "a", "b"]] } },
			{ pinnedViews: Array(201).fill("view") },
			{ karmaGoals: { daily: -1, weekly: 2 } },
			{ vacation: { active: true, until: "2026-02-30" } },
			{ quietHours: { start: "12:00", end: "12:00" } },
			{
				escalationDefaults: {
					repeatEveryMin: 0,
					maxRepeats: 3,
					fallbackUserId: null,
				},
			},
		]) {
			const value = fixture();
			Object.assign(value.data.userPrefs[0] ?? {}, update);
			expect(() => parse(value)).toThrow();
		}
	});

	test("validates recurrence syntax without expanding occurrences", () => {
		const valid = fixture();
		Object.assign(valid.data.tasks[0] ?? {}, {
			rrule: "FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2",
		});
		expect(parse(valid)).toEqual(valid);
		const invalid = fixture();
		Object.assign(invalid.data.tasks[0] ?? {}, {
			rrule: "FREQ=NOT-A-FREQUENCY",
		});
		expect(() => parse(invalid)).toThrow(PortableExportValidationError);
	});

	test("rejects excessive nesting before recursive schema validation", () => {
		const input = JSON.stringify(fixture()).replace(
			'"Keep all the text"',
			`${"[".repeat(10000)}0${"]".repeat(10000)}`,
		);
		expect(() => parsePortableExportV1(input)).toThrow("nesting limit");
	});

	test("rejects excessive filter depth inside the global nesting budget", () => {
		const value = fixture();
		let filter = {
			op: "and",
			conditions: [],
		} as PortableExportV1["data"]["views"][number]["filter"];
		for (let i = 0; i < 6; i++) filter = { op: "and", conditions: [filter] };
		Object.assign(value.data.views[0] ?? {}, { filter });
		expect(() => parse(value)).toThrow();
	});

	test("rejects malformed JSON and non-finite numeric literals", () => {
		expect(() => parsePortableExportV1('{"format":')).toThrow();
		expect(() =>
			parsePortableExportV1(
				JSON.stringify(fixture()).replace('"priority":2', '"priority":1e999'),
			),
		).toThrow("non-finite");
	});

	test("rejects NUL and ill-formed Unicode without replacing text", () => {
		const nul = fixture();
		Object.assign(nul.data.tasks[0] ?? {}, { title: "before\u0000after" });
		expect(() => parse(nul)).toThrow(PortableExportValidationError);
		const surrogate = fixture();
		Object.assign(surrogate.data.templates[0] ?? {}, {
			content: { kind: "task", task: { title: "\ud800" } },
		});
		expect(JSON.stringify(surrogate)).toContain("\\ud800");
		expect(() => parse(surrogate)).toThrow("unsupported text");
		for (const key of ["key\u0000", "key\udfff"]) {
			const value = fixture();
			Object.assign(value.data.userPrefs[0] ?? {}, {
				keymap: { [key]: [["x"]] },
			});
			expect(() => parse(value)).toThrow("unsupported text");
		}
	});

	test("counts rows across collections before schema validation", () => {
		const value = fixture();
		value.data.principals = Array.from({ length: 50000 }, (_, index) => ({
			id: `u${index}`,
			name: "User",
		}));
		expect(() => parse(value)).toThrow("row limit");
	});

	test("bounds nested filter and template arrays before domain schemas", () => {
		const filter = fixture();
		Object.assign(filter.data.views[0] ?? {}, {
			filter: {
				op: "and",
				conditions: [
					{ field: "list", operator: "in", value: Array(50001).fill("list") },
				],
			},
		});
		const template = fixture();
		Object.assign(template.data.templates[0] ?? {}, {
			content: {
				kind: "list",
				listKind: "tasks",
				tasks: Array(50001).fill({ title: "Task" }),
			},
			kind: "list",
		});
		for (const value of [filter, template]) {
			try {
				parse(value);
				throw new Error("Expected array rejection");
			} catch (error) {
				expect(error).toMatchObject({ code: "array-limit" });
			}
		}
	});

	test("bounds total visited values even when every array and file size fit", () => {
		const value = fixture();
		Object.assign(value.data.tasks[0] ?? {}, {
			notes: Array.from({ length: 41 }, () => Array(50000).fill(0)),
		});
		const input = JSON.stringify(value);
		expect(input.length).toBeLessThan(32 * 1024 * 1024);
		try {
			parsePortableExportV1(input);
			throw new Error("Expected node rejection");
		} catch (error) {
			expect(error).toMatchObject({ code: "node-limit" });
		}
	});

	test("accepts an ordinary export with exactly fifty thousand rows", () => {
		const value = fixture();
		const otherRows =
			Object.values(value.data).reduce(
				(total, rows) => total + rows.length,
				0,
			) - value.data.principals.length;
		value.data.principals = Array.from(
			{ length: 50000 - otherRows },
			(_, index) => ({ id: `u${index}`, name: "User" }),
		);
		expect(parse(value).data.principals).toHaveLength(50000 - otherRows);
	});

	test("enforces habit states while preserving zero-award migrated done logs", () => {
		for (const update of [
			{ status: "skipped", karmaDelta: 3, completedAt: null },
			{ status: "skipped", karmaDelta: 0, completedAt: stamp },
			{ status: "done", karmaDelta: -1, completedAt: stamp },
			{ status: "done", karmaDelta: 3, completedAt: null },
		]) {
			const value = fixture();
			Object.assign(value.data.habitLogs[0] ?? {}, update);
			expect(() => parse(value)).toThrow(PortableExportValidationError);
		}
		for (const update of [
			{ status: "skipped", karmaDelta: 0, completedAt: null },
			{ status: "done", karmaDelta: 0, completedAt: stamp },
		]) {
			const value = fixture();
			Object.assign(value.data.habitLogs[0] ?? {}, update);
			expect(parse(value)).toEqual(value);
		}
	});

	test("requires the stored Karma level to match its points", () => {
		const value = fixture();
		Object.assign(value.data.karma[0] ?? {}, { points: 50, level: 1 });
		expect(() => parse(value)).toThrow(PortableExportValidationError);
		Object.assign(value.data.karma[0] ?? {}, { level: 2 });
		expect(parse(value)).toEqual(value);
	});

	test("enforces the actual UTF-8 byte limit", () => {
		const value = fixture();
		Object.assign(value.data.tasks[0] ?? {}, {
			notes: "😀".repeat(8 * 1024 * 1024),
		});
		const input = JSON.stringify(value);
		expect(input.length).toBeLessThan(32 * 1024 * 1024);
		expect(() => parsePortableExportV1(input)).toThrow("byte limit");
	});
});
