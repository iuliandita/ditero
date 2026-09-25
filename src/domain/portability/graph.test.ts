import { describe, expect, test } from "vitest";
import { validateImportGraph } from "./graph.ts";
import type { PortableExportV1, PortableRows } from "./v1.ts";

const date = "2026-01-01T00:00:00.000Z";
function task(
	id: string,
	listId = "list",
	parentId: string | null = null,
): PortableRows["tasks"] {
	return {
		id,
		listId,
		parentId,
		title: "Private title",
		done: false,
		notes: null,
		dueAt: null,
		dueAllDay: false,
		priority: 0,
		completedAt: null,
		sortKey: "a",
		quantity: null,
		unit: null,
		category: null,
		rrule: null,
		recurrenceRelative: false,
		reminderTime: null,
		repeatEveryMin: null,
		maxRepeats: null,
		fallbackUserId: null,
		urgent: false,
	};
}
function fixture(): PortableExportV1 {
	return {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: date,
		sourceUserId: "self",
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "current-state-and-habit-logs",
		},
		data: {
			principals: [
				{ id: "self", name: "Private self" },
				{ id: "former", name: "Former member" },
			],
			workspaces: [
				{
					id: "workspace",
					name: "Private workspace",
					ownerId: "self",
					kind: "shared",
				},
			],
			memberships: [
				{
					id: "member",
					userId: "self",
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
					ownerId: "self",
					title: "List",
					kind: "habits",
					icon: null,
					folderId: "folder",
					sortKey: "a",
					completedDisplay: "show",
				},
			],
			tasks: [task("task"), task("child", "list", "task")],
			labels: [
				{ id: "label", workspaceId: "workspace", name: "Label", color: "red" },
			],
			taskLabels: [{ id: "task-label", taskId: "task", labelId: "label" }],
			templates: [
				{
					id: "template",
					workspaceId: "workspace",
					kind: "task",
					name: "Template",
					icon: null,
					content: { kind: "task", task: { title: "Templated" } },
					createdBy: "former",
				},
			],
			assignments: [{ id: "assignment", taskId: "task", userId: "self" }],
			comments: [
				{
					id: "comment",
					taskId: "task",
					authorId: "former",
					body: "Private comment",
					createdAt: date,
					editedAt: null,
				},
			],
			habitLogs: [
				{
					id: "log",
					habitId: "task",
					date: "2026-01-01",
					status: "done",
					karmaDelta: 1,
					completedAt: date,
					createdAt: date,
				},
			],
			views: [
				{
					id: "view",
					ownerId: "self",
					workspaceId: null,
					name: "View",
					icon: null,
					scope: "personal",
					filter: {
						op: "and",
						conditions: [
							{ field: "assignee", operator: "includes", value: "me" },
							{ field: "list", operator: "in", value: ["list"] },
						],
					},
					display: {
						layout: "list",
						groupBy: "none",
						sort: { field: "sortKey", dir: "asc" },
						workspaceScope: { mode: "one", id: "workspace" },
					},
					sortKey: "a",
					createdAt: date,
					updatedAt: date,
				},
			],
			dashboards: [
				{
					id: "dashboard",
					ownerId: "self",
					workspaceId: "workspace",
					scope: "workspace",
					name: "Dashboard",
					icon: null,
					panels: [
						{
							id: "p",
							type: "tasks",
							source: { kind: "view", viewId: "view" },
							size: "s",
						},
						{ id: "s", type: "streak", habitIds: ["task"], size: "s" },
					],
					sortKey: "a",
					createdAt: date,
					updatedAt: date,
				},
			],
			userPrefs: [
				{
					id: "self",
					keymap: {},
					keymapProfile: "default",
					homeViewRef: "dashboard:dashboard",
					pinnedViews: ["view", "today", "all-my-tasks", "assigned-to-me"],
					karmaGoals: {},
					vacation: {},
					focus: {},
					timezone: "UTC",
					quietHours: {},
					escalationDefaults: { fallbackUserId: "former" },
					locale: null,
					theme: null,
					e2eAutoLockMinutes: null,
					createdAt: date,
					updatedAt: date,
				},
			],
			focusSessions: [
				{
					id: "focus",
					userId: "self",
					taskId: "task",
					kind: "work",
					startedAt: date,
					endedAt: date,
					durationSec: 1,
					createdAt: date,
				},
			],
			karma: [{ userId: "self", points: 1, level: 1, updatedAt: date }],
			karmaEvents: [
				{
					id: "event",
					userId: "self",
					date: "2026-01-01",
					delta: 1,
					reason: "task",
					createdAt: date,
				},
			],
			attachments: [
				{
					id: "attachment",
					workspaceId: "workspace",
					parentKind: "comment",
					parentId: "comment",
					keyVersion: 1,
					declaredBytes: 1,
					observedBytes: 1,
					ciphertextSha256: null,
					thumbnailDeclaredBytes: null,
					thumbnailObservedBytes: null,
					thumbnailCiphertextSha256: null,
					uploadedBy: "former",
					createdAt: date,
					committedAt: date,
				},
			],
		},
	};
}

describe("native import graph", () => {
	test("accepts a complete source graph and historical nonmember principals without mutation", () => {
		const source = fixture();
		const before = structuredClone(source);
		expect(validateImportGraph(source)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
		expect(source).toEqual(before);
	});
	test("resolves empty source IDs and detects duplicate or missing empty references", () => {
		const source = fixture();
		source.data.folders[0].id = "";
		source.data.lists[0].folderId = "";
		expect(validateImportGraph(source)).toEqual({
			valid: true,
			errors: [],
			warnings: [],
		});
		source.data.folders.push({ ...source.data.folders[0] });
		expect(validateImportGraph(source).errors).toContainEqual({
			code: "duplicate-id",
			path: "data.folders[1].id",
		});
		source.data.folders = [];
		expect(validateImportGraph(source).errors).toContainEqual({
			code: "missing-reference",
			path: "data.lists[0].folderId",
		});
	});
	test("retains a habit log after its task moves to a non-habit list", () => {
		const source = fixture();
		source.data.lists[0].kind = "tasks";
		expect(validateImportGraph(source)).toEqual({
			valid: true,
			errors: [],
			warnings: [
				{
					code: "unresolved-reference",
					path: "data.dashboards[0].panels[1].habitIds[0]",
				},
			],
		});
		source.data.tasks = source.data.tasks.filter((row) => row.id !== "task");
		expect(validateImportGraph(source).errors).toContainEqual({
			code: "missing-reference",
			path: "data.habitLogs[0].habitId",
		});
	});
	test("requires current task-workspace membership for assignment but permits former comment authors", () => {
		const source = fixture();
		expect(validateImportGraph(source).valid).toBe(true);
		source.data.assignments[0].userId = "former";
		expect(validateImportGraph(source).errors).toEqual([
			{ code: "nonmember-assignment", path: "data.assignments[0].userId" },
		]);
	});
	test("caps combined findings and fails explicitly when warnings overflow", () => {
		const source = fixture();
		source.data.views[0].filter = {
			op: "and",
			conditions: [
				{
					field: "list",
					operator: "in",
					value: Array.from({ length: 1_000 }, (_, i) => `missing-${i}`),
				},
			],
		};
		const atLimit = validateImportGraph(source);
		expect(atLimit.valid).toBe(true);
		expect(atLimit.warnings).toHaveLength(1_000);
		source.data.userPrefs[0].homeViewRef = "missing";
		const overflow = validateImportGraph(source);
		expect(overflow.valid).toBe(false);
		expect(overflow.errors).toEqual([{ code: "finding-limit", path: "data" }]);
		expect(overflow.errors.length + overflow.warnings.length).toBe(1_000);
		source.data.assignments[0].userId = "former";
		const mixed = validateImportGraph(source);
		expect(mixed.valid).toBe(false);
		expect(mixed.errors).toContainEqual({
			code: "nonmember-assignment",
			path: "data.assignments[0].userId",
		});
		expect(mixed.errors.at(-1)).toEqual({
			code: "finding-limit",
			path: "data",
		});
		expect(mixed.errors.length + mixed.warnings.length).toBe(1_000);
	});
	test("rejects duplicates in every collection, including karma user identity", () => {
		for (const key of Object.keys(fixture().data) as (keyof PortableRows)[]) {
			const source = fixture();
			const rows = source.data[key];
			Object.assign(rows, { [rows.length]: structuredClone(rows[0]) });
			expect(validateImportGraph(source).errors).toContainEqual({
				code: "duplicate-id",
				path: `data.${key}[${rows.length - 1}].${key === "karma" ? "userId" : "id"}`,
			});
		}
	});
	test("rejects duplicate composite relationships with distinct row IDs", () => {
		for (const key of [
			"memberships",
			"labels",
			"taskLabels",
			"assignments",
			"habitLogs",
		] as const) {
			const source = fixture();
			const rows = source.data[key];
			Object.assign(rows, { [rows.length]: { ...rows[0], id: "different" } });
			expect(validateImportGraph(source).errors).toContainEqual({
				code: "duplicate-relation",
				path: `data.${key}[1]`,
			});
		}
		const source = fixture();
		source.data.workspaces[0].kind = "personal";
		source.data.workspaces.push({
			...source.data.workspaces[0],
			id: "different",
		});
		expect(validateImportGraph(source).errors).toContainEqual({
			code: "duplicate-relation",
			path: "data.workspaces[1]",
		});
	});
	test("rejects missing hard references with safe paths only", () => {
		const source = fixture();
		source.sourceUserId = "secret-missing-principal";
		source.data.comments[0].taskId = "secret-missing-task";
		source.data.assignments[0].userId = "secret-missing-user";
		const result = validateImportGraph(source);
		expect(result.valid).toBe(false);
		expect(result.errors).toContainEqual({
			code: "missing-reference",
			path: "sourceUserId",
		});
		expect(result.errors).toContainEqual({
			code: "missing-reference",
			path: "data.comments[0].taskId",
		});
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(JSON.stringify(result)).not.toContain("Private");
	});
	test("rejects self cycles, longer cycles, and third-level tasks", () => {
		for (const tasks of [
			[task("task", "list", "task")],
			[task("task", "list", "child"), task("child", "list", "task")],
			[
				task("task", "list", "b"),
				task("b", "list", "c"),
				task("c", "list", "task"),
			],
		]) {
			const source = fixture();
			source.data.tasks = tasks;
			expect(
				validateImportGraph(source).errors.some(
					(finding) => finding.code === "task-parent-cycle",
				),
			).toBe(true);
		}
		const source = fixture();
		source.data.tasks.push(task("grandchild", "list", "child"));
		expect(validateImportGraph(source).errors).toContainEqual({
			code: "subtask-depth",
			path: "data.tasks[2].parentId",
		});
	});
	test("checks list, folder, label, and attachment boundaries", () => {
		const source = fixture();
		source.data.workspaces.push({
			id: "other",
			ownerId: "self",
			kind: "shared",
			name: "Other",
		});
		source.data.folders[0].workspaceId = "other";
		source.data.labels[0].workspaceId = "other";
		source.data.attachments[0].workspaceId = "other";
		source.data.lists.push({
			...source.data.lists[0],
			id: "other-list",
			workspaceId: "other",
		});
		source.data.tasks[1].listId = "other-list";
		const result = validateImportGraph(source);
		for (const path of [
			"data.lists[0].folderId",
			"data.taskLabels[0].labelId",
			"data.attachments[0].parentId",
		])
			expect(result.errors).toContainEqual({
				code: "cross-workspace-reference",
				path,
			});
		expect(result.errors).toContainEqual({
			code: "cross-list-parent",
			path: "data.tasks[1].parentId",
		});
	});
	test("warns on missing attachment parents for every parent kind", () => {
		for (const parentKind of ["list", "task", "comment"]) {
			const source = fixture();
			Object.assign(source.data.attachments[0], {
				parentKind,
				parentId: "gone",
			});
			expect(validateImportGraph(source)).toEqual({
				valid: true,
				errors: [],
				warnings: [
					{ code: "orphan-attachment", path: "data.attachments[0].parentId" },
				],
			});
		}
	});
	test("rejects foreign personal identity without treating shared authors as personal", () => {
		const source = fixture();
		source.data.views[0].ownerId = "former";
		source.data.userPrefs[0].id = "former";
		source.data.focusSessions[0].userId = "former";
		source.data.karma[0].userId = "former";
		source.data.karmaEvents[0].userId = "former";
		const result = validateImportGraph(source);
		expect(result.errors).toHaveLength(5);
		expect(
			result.errors.every(
				(finding) => finding.code === "foreign-personal-owner",
			),
		).toBe(true);
	});
	test("checks template kind and personal/shared page scope", () => {
		const source = fixture();
		source.data.templates[0].kind = "list";
		source.data.lists[0].kind = "tasks";
		source.data.views[0].workspaceId = "workspace";
		source.data.dashboards[0].workspaceId = null;
		const result = validateImportGraph(source);
		expect(result.errors.map((finding) => finding.code)).toEqual([
			"template-kind-mismatch",
			"scope-workspace-mismatch",
			"scope-workspace-mismatch",
		]);
	});
	test("reports stale saved references as warnings, including nested filters", () => {
		const source = fixture();
		source.data.views[0].filter = {
			op: "and",
			conditions: [
				{
					op: "or",
					conditions: [
						{ field: "list", operator: "in", value: ["list", "gone"] },
						{ field: "folder", operator: "eq", value: "gone" },
						{ field: "label", operator: "includes", value: "gone" },
						{ field: "assignee", operator: "includes", value: "gone" },
						{ field: "assignee", operator: "includes", value: "me" },
					],
				},
			],
		};
		source.data.views[0].display = {
			workspaceScope: { mode: "subset", ids: ["workspace", "gone"] },
		};
		source.data.dashboards[0].panels = [
			{ source: { kind: "view", viewId: "gone" } },
			{ habitIds: ["gone"] },
			{
				source: {
					kind: "inline",
					filter: { field: "list", value: "gone" },
					workspaceScope: { mode: "one", id: "gone" },
				},
			},
		];
		source.data.userPrefs[0].homeViewRef = "dashboard:gone";
		source.data.userPrefs[0].pinnedViews = ["gone"];
		source.data.userPrefs[0].escalationDefaults = { fallbackUserId: "gone" };
		source.data.tasks[0].fallbackUserId = "gone";
		const result = validateImportGraph(source);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toHaveLength(13);
		expect(
			result.warnings.every(
				(finding) => finding.code === "unresolved-reference",
			),
		).toBe(true);
		expect(result.warnings).toContainEqual({
			code: "unresolved-reference",
			path: "data.views[0].filter.conditions[0].conditions[0].value[1]",
		});
	});
});
