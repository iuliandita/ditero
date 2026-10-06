import { describe, expect, it } from "vitest";
import type { AccountSetupRequest } from "./account-setup.ts";
import { expandAccountSetupContent } from "./account-setup-content.ts";
import { panelsSchema } from "./dashboard.ts";
import { LOCALES } from "./locale.ts";
import { createSetupPackCatalog } from "./setup-packs.ts";

const workspace = "00000000-0000-4000-8000-000000000099";
const base = {
	requestId: "00000000-0000-4000-8000-000000000098",
	expectedRevision: 0,
	catalogVersion: 1 as const,
	locale: "en" as const,
};
function ids() {
	let next = 0;
	return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}
describe("account setup content", () => {
	it.each(
		LOCALES,
	)("expands the exact localized Basic recipe in %s", (locale) => {
		const result = expandAccountSetupContent(
			{ ...base, locale, mode: "basic" },
			workspace,
			ids(),
		);
		const catalog = createSetupPackCatalog(locale, 1);
		expect(result.lists.map((list) => list.title)).toEqual([
			catalog.packs[0].title,
			catalog.packs[2].title,
		]);
		expect(result.tasks).toHaveLength(16);
		expect(result.tasks.map((task) => task.title)).toEqual(
			[
				...catalog.packs[0].content.tasks,
				...catalog.packs[2].content.tasks,
			].map((task) => task.title),
		);
		expect(result.dashboard?.title).toBe(catalog.dashboard.title);
		expect(result.dashboard?.panels.map((panel) => panel.title)).toEqual([
			catalog.dashboard.openTasksTitle,
			catalog.dashboard.overdueTitle,
		]);
		expect(result.generatedIds.listIds).toEqual(
			result.lists.map((list) => list.id),
		);
		expect(result.generatedIds.taskIds).toEqual(
			result.tasks.map((task) => task.id),
		);
		const all = [
			...result.generatedIds.listIds,
			...result.generatedIds.taskIds,
			...result.generatedIds.panelIds,
			result.generatedIds.dashboardId,
		];
		expect(new Set(all).size).toBe(21);
		expect(all).not.toContain(workspace);
		for (const task of result.tasks) {
			expect(task.done).toBe(false);
			expect(
				Object.keys(task).every((key) =>
					[
						"id",
						"listId",
						"title",
						"sortKey",
						"done",
						"category",
						"priority",
					].includes(key),
				),
			).toBe(true);
		}
		expect(result.lists[0].sortKey < result.lists[1].sortKey).toBe(true);
		for (const list of result.lists) {
			const tasks = result.tasks.filter((task) => task.listId === list.id);
			expect(tasks).toHaveLength(8);
			expect(
				tasks.every(
					(task, index) =>
						index === 0 || task.sortKey > tasks[index - 1].sortKey,
				),
			).toBe(true);
		}
	});
	it("validates exact personal dashboard filters and sizes", () => {
		const panels = expandAccountSetupContent(
			{ ...base, mode: "basic" },
			workspace,
			ids(),
		).dashboard?.panels;
		expect(panelsSchema.parse(panels)).toEqual(panels);
		expect(panels?.map((panel) => panel.size)).toEqual(["l", "l"]);
		expect(panels?.[0]).toMatchObject({
			type: "tasks",
			limit: 10,
			source: {
				kind: "inline",
				filter: {
					op: "and",
					conditions: [{ field: "done", operator: "is", value: false }],
				},
				sort: { field: "due", dir: "asc" },
				workspaceScope: { mode: "one", id: workspace },
			},
		});
		expect(panels?.[1]).toMatchObject({
			type: "counter",
			source: {
				filter: {
					op: "and",
					conditions: [{ field: "due", operator: "is", value: "overdue" }],
				},
				workspaceScope: { mode: "one", id: workspace },
			},
		});
	});
	it.each([0, 1, 2, 3])("expands %s canonical Guided packs", (count) => {
		const keys = ["cleaning", "packing", "shopping"].slice(0, count) as (
			| "cleaning"
			| "packing"
			| "shopping"
		)[];
		const result = expandAccountSetupContent(
			{ ...base, mode: "guided", starterKeys: keys, dashboard: count === 0 },
			workspace,
			ids(),
		);
		expect(result.lists).toHaveLength(count);
		expect(result.tasks).toHaveLength(count * 8);
		expect(Boolean(result.dashboard)).toBe(count === 0);
		const canonical = createSetupPackCatalog("en", 1).packs.filter((pack) =>
			keys.includes(pack.key),
		);
		expect(result.lists.map((list) => list.title)).toEqual(
			canonical.map((pack) => pack.title),
		);
	});
	it.each([
		"custom",
		"skip",
	] as const)("does not generate IDs for %s", (mode) => {
		const result = expandAccountSetupContent(
			{ ...base, mode },
			workspace,
			() => {
				throw new Error("Must not generate");
			},
		);
		expect(result).toEqual({
			lists: [],
			tasks: [],
			dashboard: null,
			generatedIds: {
				listIds: [],
				taskIds: [],
				dashboardId: null,
				panelIds: [],
			},
		});
	});
	it.each([
		"bad",
		"",
		workspace,
		workspace.toUpperCase(),
	])("rejects bad or workspace-colliding ID %s", (id) => {
		expect(() =>
			expandAccountSetupContent(
				{ ...base, mode: "basic" },
				workspace,
				() => id,
			),
		).toThrow();
	});
	it("rejects globally duplicate generated IDs across lists and panels", () => {
		expect(() =>
			expandAccountSetupContent(
				{ ...base, mode: "basic" },
				workspace,
				() => "00000000-0000-4000-8000-000000000001",
			),
		).toThrow();
		const gen = ids();
		let calls = 0;
		expect(() =>
			expandAccountSetupContent({ ...base, mode: "basic" }, workspace, () =>
				++calls === 20 ? "00000000-0000-4000-8000-000000000001" : gen(),
			),
		).toThrow();
	});
	it("refuses invalid request before ID generation", () => {
		expect(() =>
			expandAccountSetupContent(
				{
					...base,
					mode: "guided",
					starterKeys: [],
					dashboard: false,
				} as AccountSetupRequest,
				workspace,
				() => {
					throw new Error("Unexpected ID generation");
				},
			),
		).toThrow("Choose content or Custom");
	});
});
