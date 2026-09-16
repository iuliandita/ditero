import { describe, expect, test } from "vitest";
import {
	buildImportPlan,
	type ImportMappings,
	ImportPlanError,
} from "./import-plan.ts";
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
					completedDisplay: "sink",
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
					karmaGoals: null,
					vacation: null,
					focus: null,
					timezone: "UTC",
					quietHours: null,
					escalationDefaults: {
						fallbackUserId: "former",
						repeatEveryMin: null,
						maxRepeats: null,
					},
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

const context = {
	ownerUserId: "owner",
	sourceId: "source-uuid",
	mappings: {
		workspaces: { workspace: "target-workspace" },
		principals: { self: "owner", former: "other" },
	},
};
const plan = (source = fixture()) => buildImportPlan(source, context);
describe("saved native dry-run plan", () => {
	test("canonicalizes keys, table order and export timestamp without mutating input", async () => {
		const source = fixture();
		const before = structuredClone(source);
		const first = await plan(source);
		expect(source).toEqual(before);
		source.exportedAt = "2026-02-01T00:00:00.000Z";
		source.data.tasks.reverse();
		source.data.principals.reverse();
		const reordered = JSON.parse(
			JSON.stringify(source, (_key, value) =>
				value && !Array.isArray(value) && typeof value === "object"
					? Object.fromEntries(Object.entries(value).reverse())
					: value,
			),
		);
		const second = await plan(reordered);
		expect(second).toEqual(first);
		expect(before.data.tasks).toEqual(fixture().data.tasks);
	});
	test("content changes digest but not source keys or target candidates", async () => {
		const source = fixture();
		const first = await plan(source);
		source.data.tasks[0].title = "Changed";
		const second = await plan(source);
		expect(second.documentDigest).not.toBe(first.documentDigest);
		expect(second.planDigest).not.toBe(first.planDigest);
		const old = first.items.find((i) => i.sourceId === "task");
		const next = second.items.find((i) => i.sourceId === "task");
		expect(next?.sourceKey).toBe(old?.sourceKey);
		expect(next?.targetId).toBe(old?.targetId);
		expect(next?.itemDigest).not.toBe(old?.itemDigest);
	});
	test("isolates source and owner while mappings only change plan identity", async () => {
		const first = await plan();
		const mapped = await buildImportPlan(fixture(), {
			...context,
			mappings: { ...context.mappings, workspaces: { workspace: "another" } },
		});
		expect(mapped.mappingDigest).not.toBe(first.mappingDigest);
		expect(mapped.planDigest).not.toBe(first.planDigest);
		expect(mapped.items.map((i) => i.sourceKey)).toEqual(
			first.items.map((i) => i.sourceKey),
		);
		for (const changed of [
			{ ...context, sourceId: "another-source" },
			{
				...context,
				ownerUserId: "new-owner",
				mappings: {
					...context.mappings,
					principals: { self: "new-owner", former: "other" },
				},
			},
		]) {
			const result = await buildImportPlan(fixture(), changed);
			expect(result.planDigest).not.toBe(first.planDigest);
			expect(result.items[0].sourceKey).not.toBe(first.items[0].sourceKey);
		}
	});
	test("never imports grants, attachment provenance, foreign authors or personal overwrites", async () => {
		const result = await plan();
		expect(result.report.applySupported).toBe(false);
		expect(result.report.plannerVersion).toBe(1);
		for (const item of result.items) {
			if (
				["workspaces", "memberships", "principals", "attachments"].includes(
					item.collection,
				)
			)
				expect(item.disposition).toBe("ignored");
			if (
				[
					"comments",
					"templates",
					"userPrefs",
					"karma",
					"karmaEvents",
					"habitLogs",
				].includes(item.collection)
			)
				expect(item.disposition).toBe("blocked");
		}
		const comment = result.items.find((i) => i.collection === "comments");
		expect(comment?.payload).toEqual(fixture().data.comments[0]);
		const source = fixture();
		source.data.comments[0].authorId = "self";
		expect(
			(await plan(source)).items.find((i) => i.collection === "comments")
				?.payload,
		).toMatchObject({ authorId: "owner" });
	});
	test("remaps nested filters, scopes, panel sources and task parents", async () => {
		const source = fixture();
		source.data.views[0].filter = {
			op: "and",
			conditions: [
				{
					op: "or",
					conditions: [
						{ field: "list", operator: "in", value: ["list"] },
						{ field: "assignee", operator: "includes", value: "former" },
					],
				},
			],
		};
		const result = await plan(source);
		const target = (id: string) =>
			result.items.find((i) => i.sourceId === id)?.targetId;
		expect(
			result.items.find((i) => i.collection === "views")?.payload,
		).toMatchObject({
			filter: {
				op: "and",
				conditions: [
					{
						op: "or",
						conditions: [
							{ field: "list", operator: "in", value: [target("list")] },
							{ field: "assignee", operator: "includes", value: "other" },
						],
					},
				],
			},
			display: { workspaceScope: { mode: "one", id: "target-workspace" } },
		});
		expect(
			result.items.find((i) => i.sourceId === "child")?.payload,
		).toMatchObject({ parentId: target("task"), listId: target("list") });
		expect(
			result.items.find((i) => i.collection === "dashboards")?.payload,
		).toMatchObject({
			panels: [
				{
					id: "p",
					type: "tasks",
					source: { kind: "view", viewId: target("view") },
					size: "s",
				},
				{ id: "s", type: "streak", habitIds: [target("task")], size: "s" },
			],
		});
	});
	test("blocks unresolved soft refs and dependents rather than dropping semantics", async () => {
		const source = fixture();
		source.data.views[0].filter = {
			op: "and",
			conditions: [{ field: "list", operator: "eq", value: "missing" }],
		};
		const result = await plan(source);
		expect(
			result.items.find((i) => i.collection === "views")?.disposition,
		).toBe("blocked");
		expect(
			result.items.find((i) => i.collection === "dashboards")?.codes,
		).toContain("blocked-dependency");
		expect(result.items.find((i) => i.collection === "views")?.payload).toEqual(
			source.data.views[0],
		);
	});
	test("preserves nested array order in document identity", async () => {
		const source = fixture();
		const first = await plan(source);
		if (Array.isArray(source.data.dashboards[0].panels))
			source.data.dashboards[0].panels.reverse();
		expect((await plan(source)).documentDigest).not.toBe(first.documentDigest);
	});
	test("rejects incomplete, surplus and caller-impersonating mappings and invalid graphs", async () => {
		const invalidMappings: ImportMappings[] = [
			{ ...context.mappings, principals: { self: "owner" } },
			{
				...context.mappings,
				workspaces: { workspace: "target", extra: "target" },
			},
			{ ...context.mappings, principals: { self: "other", former: null } },
		];
		for (const mappings of invalidMappings) {
			await expect(
				buildImportPlan(fixture(), { ...context, mappings }),
			).rejects.toMatchObject({ code: "invalid-mappings" });
		}
		const source = fixture();
		source.data.tasks[0].listId = "missing";
		await expect(plan(source)).rejects.toBeInstanceOf(ImportPlanError);
		await expect(plan(source)).rejects.toMatchObject({ code: "invalid-graph" });
	});
	test("blocks null active principals and merged unique relations", async () => {
		const source = fixture();
		source.data.memberships.push({
			id: "former-member",
			userId: "former",
			workspaceId: "workspace",
			role: "member",
		});
		source.data.assignments.push({
			id: "other-assignment",
			taskId: "task",
			userId: "former",
		});
		const nulled = await buildImportPlan(source, {
			...context,
			mappings: {
				...context.mappings,
				principals: { self: "owner", former: null },
			},
		});
		expect(
			nulled.items.find((i) => i.sourceId === "other-assignment")?.codes,
		).toContain("unmapped-reference");
		const merged = await buildImportPlan(source, {
			...context,
			mappings: {
				...context.mappings,
				principals: { self: "owner", former: "owner" },
			},
		});
		expect(
			merged.items
				.filter((i) => i.collection === "assignments")
				.every((i) => i.codes.includes("mapping-conflict")),
		).toBe(true);
	});
	test("blocks a nonhabit streak reference even when its task exists", async () => {
		const source = fixture();
		source.data.habitLogs = [];
		source.data.lists[0].kind = "tasks";
		const result = await plan(source);
		expect(
			result.items.find((item) => item.collection === "dashboards")?.codes,
		).toContain("unresolved-reference");
	});
	test("blocks colliding labels after workspace mapping and their relationships", async () => {
		const source = fixture();
		source.data.workspaces.push({ ...source.data.workspaces[0], id: "second" });
		source.data.labels.push({
			...source.data.labels[0],
			id: "second-label",
			workspaceId: "second",
		});
		const result = await buildImportPlan(source, {
			...context,
			mappings: {
				...context.mappings,
				workspaces: {
					workspace: "target-workspace",
					second: "target-workspace",
				},
			},
		});
		expect(
			result.items
				.filter((item) => item.collection === "labels")
				.every((item) => item.codes.includes("mapping-conflict")),
		).toBe(true);
		expect(
			result.items.find((item) => item.collection === "taskLabels")?.codes,
		).toContain("blocked-dependency");
	});
	test("item digests cover final mapping and blocked dispositions", async () => {
		const first = await plan();
		const mapped = await buildImportPlan(fixture(), {
			...context,
			mappings: {
				...context.mappings,
				workspaces: { workspace: "changed-target" },
			},
		});
		const firstFolder = first.items.find(
			(item) => item.collection === "folders",
		);
		const mappedFolder = mapped.items.find(
			(item) => item.collection === "folders",
		);
		expect(mappedFolder?.sourceKey).toBe(firstFolder?.sourceKey);
		expect(mappedFolder?.targetId).toBe(firstFolder?.targetId);
		expect(mappedFolder?.itemDigest).not.toBe(firstFolder?.itemDigest);
		const source = fixture();
		source.data.tasks[0].fallbackUserId = "former";
		const ensured = await plan(source);
		const blocked = await buildImportPlan(source, {
			...context,
			mappings: {
				...context.mappings,
				principals: { self: "owner", former: null },
			},
		});
		expect(
			blocked.items.find((item) => item.sourceId === "task")?.itemDigest,
		).not.toBe(
			ensured.items.find((item) => item.sourceId === "task")?.itemDigest,
		);
	});
	test("orders candidates by dependencies including parents before alphabetically earlier children", async () => {
		const result = await plan();
		const ordinal = (id: string) =>
			result.items.find((item) => item.sourceId === id)?.ordinal ?? -1;
		for (const [dependency, dependent] of [
			["self", "workspace"],
			["workspace", "folder"],
			["folder", "list"],
			["list", "task"],
			["task", "child"],
			["task", "assignment"],
			["label", "task-label"],
			["task", "comment"],
			["task", "focus"],
			["view", "dashboard"],
		]) {
			expect(ordinal(dependency)).toBeLessThan(ordinal(dependent));
		}
		expect(result.items.map((item) => item.ordinal)).toEqual(
			result.items.map((_item, index) => index),
		);
	});
	test("rejects an expired planning budget before doing work", async () => {
		await expect(
			buildImportPlan(fixture(), {
				...context,
				deadline: performance.now() - 1,
			}),
		).rejects.toMatchObject({ code: "planning-timeout" });
	});
	test("stops a cancelled plan after its in-flight hash settles", async () => {
		const controller = new AbortController();
		const pending = buildImportPlan(fixture(), {
			...context,
			signal: controller.signal,
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "planning-cancelled" });
	});
	test("fails closed on report overflow", async () => {
		const source = fixture();
		source.data.comments = Array.from({ length: 1001 }, (_, i) => ({
			...source.data.comments[0],
			id: `comment-${i}`,
		}));
		source.data.attachments = [];
		await expect(plan(source)).rejects.toMatchObject({ code: "finding-limit" });
	});
});
