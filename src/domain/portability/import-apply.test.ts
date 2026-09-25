import { describe, expect, test } from "vitest";
import { projectImportApply } from "./import-apply.ts";
import { buildImportPlan } from "./import-plan.ts";
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
	sourceId: "source",
	mappings: {
		workspaces: { workspace: "target" },
		principals: { self: "owner", former: "owner" },
	},
};
async function project(source = fixture()) {
	const plan = await buildImportPlan(source, context);
	return projectImportApply(source, plan.items);
}
describe("import apply eligibility", () => {
	test("v3 assigns mapped members with canonical pair IDs after task-labels", async () => {
		const source = fixture();
		source.data.assignments.push({
			id: "child-assignment",
			taskId: "child",
			userId: "former",
		});
		source.data.memberships.push({
			id: "viewer-seat",
			userId: "former",
			workspaceId: "workspace",
			role: "viewer",
		});
		const plan = await buildImportPlan(source, {
			...context,
			mappings: {
				...context.mappings,
				principals: { self: "owner", former: "target-member" },
			},
		});
		const before = structuredClone({ source, plan });
		const result = projectImportApply(source, plan.items, {
			plannerVersion: 3,
		});
		const link = result.items.find((item) => item.collection === "taskLabels");
		for (const [id, taskId, userId] of [
			["assignment", "task", "owner"],
			["child-assignment", "child", "target-member"],
		]) {
			const assignedTask = result.items.find(
				(item) => item.collection === "tasks" && item.sourceId === taskId,
			);
			const original = plan.items.find((item) => item.sourceId === id);
			const assignment = result.items.find((item) => item.sourceId === id);
			expect(assignment).toMatchObject({
				sourceId: id,
				sourceKey: original?.sourceKey,
				disposition: "ensure",
				phase: "assignments",
				targetId: `${assignedTask?.targetId}:${userId}`,
				payload: {
					id: `${assignedTask?.targetId}:${userId}`,
					taskId: assignedTask?.targetId,
					userId,
				},
				dependencies: [
					{
						collection: "tasks",
						sourceId: taskId,
						sourceKey: assignedTask?.sourceKey,
					},
				],
			});
			expect(assignment?.ordinal).toBeGreaterThan(link?.ordinal ?? Infinity);
		}
		expect({ source, plan }).toEqual(before);
		expect(
			result.items.filter((item) => item.collection !== "assignments"),
		).toEqual(
			projectImportApply(source, plan.items).items.filter(
				(item) => item.collection !== "assignments",
			),
		);
	});
	test("v3 preserves unmapped assignments without blocking supported tasks or assignees", async () => {
		const source = fixture();
		source.data.memberships.push({
			id: "former-seat",
			userId: "former",
			workspaceId: "workspace",
			role: "member",
		});
		source.data.assignments.push({
			id: "unmapped-assignment",
			taskId: "task",
			userId: "former",
		});
		const plan = await buildImportPlan(source, {
			...context,
			mappings: {
				...context.mappings,
				principals: { self: "owner", former: null },
			},
		});
		const result = projectImportApply(source, plan.items, {
			plannerVersion: 3,
		});
		expect(
			result.items.find((item) => item.sourceId === "unmapped-assignment"),
		).toMatchObject({
			disposition: "blocked",
			targetId: null,
			phase: null,
			codes: ["unmapped-reference"],
			payload: source.data.assignments[1],
		});
		for (const id of ["task", "child", "assignment"])
			expect(
				result.items.find((item) => item.sourceId === id)?.disposition,
			).toBe("ensure");
	});
	test("v3 keeps both assignments excluded when principal mappings collapse their pair", async () => {
		const source = fixture();
		source.data.memberships.push({
			id: "former-seat",
			userId: "former",
			workspaceId: "workspace",
			role: "member",
		});
		source.data.assignments.push({
			id: "duplicate-assignment",
			taskId: "task",
			userId: "former",
		});
		const plan = await buildImportPlan(source, context);
		const result = projectImportApply(source, plan.items, {
			plannerVersion: 3,
		});
		for (const original of source.data.assignments)
			expect(
				result.items.find((item) => item.sourceId === original.id),
			).toMatchObject({
				disposition: "blocked",
				targetId: null,
				phase: null,
				codes: ["mapping-conflict"],
				payload: original,
			});
		expect(
			result.items.find((item) => item.sourceId === "task")?.disposition,
		).toBe("ensure");
	});
	test.each([
		"folder",
		"foreign-owner",
		"reminder",
		"due-date",
	])("v3 closes %s exclusions through child-task assignments", async (reason) => {
		const source = fixture();
		source.data.assignments[0].taskId = "child";
		if (reason === "foreign-owner") source.data.lists[0].ownerId = "former";
		if (reason === "reminder") source.data.tasks[0].reminderTime = "09:00";
		if (reason === "due-date")
			source.data.tasks[0].dueAt = "2100-01-01T00:00:00.000Z";
		const plan = await buildImportPlan(source, context);
		if (reason === "folder") {
			const folder = plan.items.find((item) => item.collection === "folders");
			if (!folder) throw new Error("Missing fixture folder");
			folder.disposition = "blocked";
			folder.codes.push("target-conflict");
		}
		const result = projectImportApply(source, plan.items, {
			plannerVersion: 3,
		});
		expect(
			result.items.find((item) => item.collection === "assignments"),
		).toMatchObject({
			disposition: "blocked",
			phase: null,
			targetId: null,
			codes: ["blocked-dependency"],
			payload: source.data.assignments[0],
		});
		expect(
			result.items.find((item) => item.collection === "labels")?.disposition,
		).toBe("ensure");
	});
	test("rejects an unknown projection version", async () => {
		const source = fixture();
		const plan = await buildImportPlan(source, context);
		expect(() =>
			projectImportApply(source, plan.items, { plannerVersion: 4 as 3 }),
		).toThrow("invalid-mappings");
	});
	test("projects supported phases and explicit dependencies without mutating either input", async () => {
		const source = fixture();
		const plan = await buildImportPlan(source, context);
		const before = structuredClone({ source, plan });
		const result = projectImportApply(source, plan.items);
		expect({ source, plan }).toEqual(before);
		const item = (id: string) => result.items.find((i) => i.sourceId === id);
		expect(item("task")?.phase).toBe("root-tasks");
		expect(item("child")?.phase).toBe("child-tasks");
		expect(item("child")?.dependencies).toEqual([
			{
				collection: "lists",
				sourceId: "list",
				sourceKey: item("list")?.sourceKey,
			},
			{
				collection: "tasks",
				sourceId: "task",
				sourceKey: item("task")?.sourceKey,
			},
		]);
		expect(item("task-label")?.dependencies).toEqual([
			{
				collection: "tasks",
				sourceId: "task",
				sourceKey: item("task")?.sourceKey,
			},
			{
				collection: "labels",
				sourceId: "label",
				sourceKey: item("label")?.sourceKey,
			},
		]);
		expect(item("list")?.dependencies[0].sourceKey).toBe(
			item("folder")?.sourceKey,
		);
		expect(result.counts).toEqual({ ensure: 6, ignored: 5, blocked: 10 });
		expect(item("task")).not.toHaveProperty("itemDigest");
		expect(result).not.toHaveProperty("applySupported");
		expect(
			result.items
				.filter((i) => i.codes.includes("unsupported-collection"))
				.map((i) => i.collection),
		).toEqual(["assignments", "focusSessions", "views", "dashboards"]);
		for (const original of plan.items.filter(
			(i) => i.disposition !== "ensure",
		)) {
			const candidate = result.items.find(
				(i) => i.sourceKey === original.sourceKey,
			);
			expect(candidate?.disposition).toBe(original.disposition);
			expect(candidate?.codes).toEqual(original.codes);
		}
		const payload = item("task")?.payload;
		if (payload && typeof payload === "object" && !Array.isArray(payload))
			payload.title = "Changed";
		expect({ source, plan }).toEqual(before);
	});
	test("blocks original foreign owners even when they map to the caller, then closes dependencies", async () => {
		const source = fixture();
		source.data.lists[0].ownerId = "former";
		const result = await project(source);
		expect(result.items.find((i) => i.sourceId === "list")?.codes).toContain(
			"foreign-list-owner",
		);
		for (const id of ["task", "child", "task-label"]) {
			expect(result.items.find((i) => i.sourceId === id)).toMatchObject({
				disposition: "blocked",
				targetId: null,
				phase: null,
				codes: ["blocked-dependency"],
			});
		}
		expect(result.items.find((i) => i.sourceId === "folder")?.disposition).toBe(
			"ensure",
		);
		expect(result.items.find((i) => i.sourceId === "label")?.disposition).toBe(
			"ensure",
		);
	});
	test.each([
		{ reminderTime: "09:00" },
		{ repeatEveryMin: 5 },
		{ maxRepeats: 1 },
		{ fallbackUserId: "former" },
		{ urgent: true },
		{ dueAt: "2020-01-01T00:00:00.000Z" },
		{ dueAt: "2100-01-01T00:00:00.000Z" },
	])("excludes reminder policy %j and descendants but keeps unrelated tasks", async (policy) => {
		const source = fixture();
		Object.assign(source.data.tasks[0], policy);
		source.data.tasks.push(task("unrelated"));
		const result = await project(source);
		expect(result.items.find((i) => i.sourceId === "task")?.codes).toContain(
			"notification-bearing-task",
		);
		expect(result.items.find((i) => i.sourceId === "child")?.codes).toContain(
			"blocked-dependency",
		);
		expect(
			result.items.find((i) => i.sourceId === "task-label")?.codes,
		).toContain("blocked-dependency");
		expect(
			result.items.find((i) => i.sourceId === "unrelated")?.disposition,
		).toBe("ensure");
		expect(result.items.find((i) => i.sourceId === "task")?.payload).toEqual(
			source.data.tasks[0],
		);
	});
	test("keeps completed dated tasks eligible but blocks dated unfinished habits", async () => {
		const source = fixture();
		source.data.lists[0].kind = "habits";
		Object.assign(source.data.tasks[0], {
			done: true,
			dueAt: date,
			completedAt: date,
		});
		source.data.tasks[1].dueAt = date;
		const result = await project(source);
		expect(result.items.find((i) => i.sourceId === "task")?.disposition).toBe(
			"ensure",
		);
		expect(result.items.find((i) => i.sourceId === "child")?.codes).toContain(
			"notification-bearing-task",
		);
	});
	test("closes folder and label dependencies independent of input order", async () => {
		const source = fixture();
		const plan = await buildImportPlan(source, context);
		for (const item of plan.items) {
			if (item.collection === "folders" || item.collection === "labels") {
				item.disposition = "blocked";
				item.codes = ["target-conflict"];
			}
		}
		const result = projectImportApply(source, plan.items.reverse());
		for (const id of ["list", "task", "child", "task-label"]) {
			expect(result.items.find((i) => i.sourceId === id)?.codes).toContain(
				"blocked-dependency",
			);
		}
	});
	test("honors cancellation and deadline", async () => {
		const source = fixture();
		const plan = await buildImportPlan(source, context);
		expect(() =>
			projectImportApply(source, plan.items, {
				deadline: performance.now() - 1,
			}),
		).toThrow("planning-timeout");
		expect(() =>
			projectImportApply(source, plan.items, { signal: AbortSignal.abort() }),
		).toThrow("planning-cancelled");
	});
});
