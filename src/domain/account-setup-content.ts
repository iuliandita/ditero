import { generateKeyBetween } from "fractional-indexing";
import { z } from "zod";
import {
	type AccountSetupRequest,
	accountSetupRequestSchema,
	accountSetupSelection,
} from "./account-setup.ts";
import { type Panel, panelsSchema } from "./dashboard.ts";
import { createSetupPackCatalog } from "./setup-packs.ts";
import {
	type InstantiatedList,
	type InstantiatedTask,
	instantiate,
	templateContentSchema,
} from "./template.ts";

export type AccountSetupContent = {
	lists: InstantiatedList[];
	tasks: InstantiatedTask[];
	dashboard: {
		id: string;
		title: string;
		workspaceId: string;
		panels: Panel[];
	} | null;
	generatedIds: {
		listIds: string[];
		taskIds: string[];
		dashboardId: string | null;
		panelIds: string[];
	};
};
const idSchema = z.string().uuid().max(64);

// Caller persists this plan and its ID receipt atomically with the setup transition.
export function expandAccountSetupContent(
	input: AccountSetupRequest,
	personalWorkspaceId: string,
	idGen: () => string,
): AccountSetupContent {
	const request = accountSetupRequestSchema.parse(input);
	const workspaceId = idSchema.parse(personalWorkspaceId);
	const selection = accountSetupSelection(request);
	const content: AccountSetupContent = {
		lists: [],
		tasks: [],
		dashboard: null,
		generatedIds: { listIds: [], taskIds: [], dashboardId: null, panelIds: [] },
	};
	if (!selection.starterKeys.length && !selection.dashboard) return content;
	const seen = new Set([workspaceId.toLowerCase()]);
	const freshId = () => {
		const id = idSchema.parse(idGen());
		const canonical = id.toLowerCase();
		if (seen.has(canonical))
			throw new Error("account-setup: duplicate generated ID");
		seen.add(canonical);
		return id;
	};
	const catalog = createSetupPackCatalog(
		request.locale,
		request.catalogVersion,
	);
	let previousListKey: string | null = null;
	for (const pack of catalog.packs) {
		if (!selection.starterKeys.includes(pack.key)) continue;
		const sortKey = generateKeyBetween(previousListKey, null);
		previousListKey = sortKey;
		const expanded = instantiate(
			templateContentSchema.parse(pack.content),
			freshId,
			generateKeyBetween,
			{ title: pack.title, sortKey },
		);
		if (!expanded.list) throw new Error("account-setup: missing expanded list");
		content.lists.push(expanded.list);
		content.tasks.push(...expanded.tasks);
	}
	if (selection.dashboard) {
		const id = freshId();
		const panels = panelsSchema.parse([
			{
				id: freshId(),
				type: "tasks",
				title: catalog.dashboard.openTasksTitle,
				size: "l",
				limit: 10,
				source: {
					kind: "inline",
					filter: {
						op: "and",
						conditions: [{ field: "done", operator: "is", value: false }],
					},
					sort: { field: "due", dir: "asc" },
					workspaceScope: { mode: "one", id: workspaceId },
				},
			},
			{
				id: freshId(),
				type: "counter",
				title: catalog.dashboard.overdueTitle,
				size: "l",
				source: {
					kind: "inline",
					filter: {
						op: "and",
						conditions: [{ field: "due", operator: "is", value: "overdue" }],
					},
					sort: { field: "due", dir: "asc" },
					workspaceScope: { mode: "one", id: workspaceId },
				},
			},
		]);
		content.dashboard = {
			id,
			title: catalog.dashboard.title,
			workspaceId,
			panels,
		};
	}
	content.generatedIds = {
		listIds: content.lists.map((list) => list.id),
		taskIds: content.tasks.map((task) => task.id),
		dashboardId: content.dashboard?.id ?? null,
		panelIds: content.dashboard?.panels.map((panel) => panel.id) ?? [],
	};
	return content;
}
