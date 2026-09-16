import type { PortableExportV1, PortableJson, PortableRows } from "./v1.ts";

export interface ImportGraphFinding {
	code: string;
	path: string;
}

function object(value: PortableJson): Record<string, PortableJson> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

// Shape and total input-size validation must run first. All lookups are source-local.
export function validateImportGraph(source: PortableExportV1): {
	valid: boolean;
	errors: ImportGraphFinding[];
	warnings: ImportGraphFinding[];
} {
	const errors: ImportGraphFinding[] = [];
	const warnings: ImportGraphFinding[] = [];
	const { data, sourceUserId } = source;
	let findingLimitReached = false;
	let lastFindings = errors;
	function finding(target: ImportGraphFinding[], code: string, path: string) {
		if (findingLimitReached) return;
		if (errors.length + warnings.length === 1_000) {
			// Reserve the last slot for an explicit failure, even after warnings only.
			lastFindings.pop();
			errors.push({ code: "finding-limit", path: "data" });
			findingLimitReached = true;
			return;
		}
		target.push({ code, path });
		lastFindings = target;
	}
	const error = (code: string, path: string) => finding(errors, code, path);
	const warning = (code: string, path: string) => finding(warnings, code, path);
	function index<K extends keyof PortableRows>(
		key: K,
	): Map<string, PortableRows[K]> {
		const result = new Map<string, PortableRows[K]>();
		data[key].forEach((row, i) => {
			const id = "id" in row ? row.id : (row as PortableRows["karma"]).userId;
			if (result.has(id))
				error(
					"duplicate-id",
					`data.${key}[${i}].${key === "karma" ? "userId" : "id"}`,
				);
			else result.set(id, row);
		});
		return result;
	}
	const principals = index("principals");
	const workspaces = index("workspaces");
	index("memberships");
	const folders = index("folders");
	const lists = index("lists");
	const tasks = index("tasks");
	const labels = index("labels");
	index("taskLabels");
	index("templates");
	index("assignments");
	const comments = index("comments");
	index("habitLogs");
	const views = index("views");
	const dashboards = index("dashboards");
	index("userPrefs");
	index("focusSessions");
	index("karma");
	index("karmaEvents");
	index("attachments");
	function unique<K extends keyof PortableRows>(
		key: K,
		fields: (row: PortableRows[K]) => string[] | null,
	) {
		const seen = new Set<string>();
		data[key].forEach((row, i) => {
			const values = fields(row);
			if (values === null) return;
			const tuple = JSON.stringify(values);
			if (seen.has(tuple)) error("duplicate-relation", `data.${key}[${i}]`);
			seen.add(tuple);
		});
	}
	unique("memberships", (row) => [row.userId, row.workspaceId]);
	unique("labels", (row) => [row.workspaceId, row.name]);
	unique("taskLabels", (row) => [row.taskId, row.labelId]);
	unique("assignments", (row) => [row.taskId, row.userId]);
	unique("habitLogs", (row) => [row.habitId, row.date]);
	unique("workspaces", (row) =>
		row.kind === "personal" ? [row.ownerId] : null,
	);
	function requireRef(
		map: ReadonlyMap<string, unknown>,
		id: string,
		path: string,
	) {
		if (!map.has(id)) error("missing-reference", path);
	}
	function own(id: string, path: string) {
		if (id !== sourceUserId) error("foreign-personal-owner", path);
	}
	function sameWorkspace(
		a: string | undefined,
		b: string | undefined,
		path: string,
	) {
		if (a !== undefined && b !== undefined && a !== b)
			error("cross-workspace-reference", path);
	}
	const taskWorkspace = (id: string) => {
		const task = tasks.get(id);
		return task ? lists.get(task.listId)?.workspaceId : undefined;
	};
	requireRef(principals, sourceUserId, "sourceUserId");
	data.workspaces.forEach((row, i) => {
		requireRef(principals, row.ownerId, `data.workspaces[${i}].ownerId`);
	});
	data.memberships.forEach((row, i) => {
		requireRef(principals, row.userId, `data.memberships[${i}].userId`);
		requireRef(
			workspaces,
			row.workspaceId,
			`data.memberships[${i}].workspaceId`,
		);
	});
	data.folders.forEach((row, i) => {
		requireRef(workspaces, row.workspaceId, `data.folders[${i}].workspaceId`);
	});
	data.lists.forEach((row, i) => {
		const path = `data.lists[${i}]`;
		requireRef(workspaces, row.workspaceId, `${path}.workspaceId`);
		requireRef(principals, row.ownerId, `${path}.ownerId`);
		if (row.folderId !== null) {
			requireRef(folders, row.folderId, `${path}.folderId`);
			sameWorkspace(
				row.workspaceId,
				folders.get(row.folderId)?.workspaceId,
				`${path}.folderId`,
			);
		}
	});
	data.tasks.forEach((row, i) => {
		const path = `data.tasks[${i}]`;
		requireRef(lists, row.listId, `${path}.listId`);
		if (row.parentId !== null) {
			requireRef(tasks, row.parentId, `${path}.parentId`);
			const parent = tasks.get(row.parentId);
			if (parent && parent.listId !== row.listId)
				error("cross-list-parent", `${path}.parentId`);
			if (parent && parent.parentId !== null)
				error("subtask-depth", `${path}.parentId`);
		}
		if (row.fallbackUserId !== null && !principals.has(row.fallbackUserId))
			warning("unresolved-reference", `${path}.fallbackUserId`);
	});
	// Each task is visited once, including malformed deep chains and cycles.
	const visited = new Set<string>();
	const taskPositions = new Map(data.tasks.map((row, i) => [row.id, i]));
	for (const row of data.tasks) {
		const chain = new Set<string>();
		let id: string | null = row.id;
		while (id !== null && !visited.has(id) && tasks.has(id)) {
			if (chain.has(id)) {
				error(
					"task-parent-cycle",
					`data.tasks[${taskPositions.get(id)}].parentId`,
				);
				break;
			}
			chain.add(id);
			id = tasks.get(id)?.parentId ?? null;
		}
		for (const member of chain) visited.add(member);
	}
	data.labels.forEach((row, i) => {
		requireRef(workspaces, row.workspaceId, `data.labels[${i}].workspaceId`);
	});
	data.taskLabels.forEach((row, i) => {
		const path = `data.taskLabels[${i}]`;
		requireRef(tasks, row.taskId, `${path}.taskId`);
		requireRef(labels, row.labelId, `${path}.labelId`);
		sameWorkspace(
			taskWorkspace(row.taskId),
			labels.get(row.labelId)?.workspaceId,
			`${path}.labelId`,
		);
	});
	data.templates.forEach((row, i) => {
		const path = `data.templates[${i}]`;
		requireRef(workspaces, row.workspaceId, `${path}.workspaceId`);
		requireRef(principals, row.createdBy, `${path}.createdBy`);
		if (object(row.content).kind !== row.kind)
			error("template-kind-mismatch", `${path}.content.kind`);
	});
	const membershipPairs = new Set(
		data.memberships.map((row) =>
			JSON.stringify([row.userId, row.workspaceId]),
		),
	);
	data.assignments.forEach((row, i) => {
		requireRef(tasks, row.taskId, `data.assignments[${i}].taskId`);
		requireRef(principals, row.userId, `data.assignments[${i}].userId`);
		const workspaceId = taskWorkspace(row.taskId);
		if (
			workspaceId !== undefined &&
			!membershipPairs.has(JSON.stringify([row.userId, workspaceId]))
		)
			error("nonmember-assignment", `data.assignments[${i}].userId`);
	});
	data.comments.forEach((row, i) => {
		requireRef(tasks, row.taskId, `data.comments[${i}].taskId`);
		requireRef(principals, row.authorId, `data.comments[${i}].authorId`);
	});
	const isHabit = (id: string) => {
		const task = tasks.get(id);
		return task !== undefined && lists.get(task.listId)?.kind === "habits";
	};
	data.habitLogs.forEach((row, i) => {
		const path = `data.habitLogs[${i}].habitId`;
		requireRef(tasks, row.habitId, path);
		if (tasks.has(row.habitId) && !isHabit(row.habitId))
			error("not-a-habit", path);
	});
	function softRef(
		map: ReadonlyMap<string, unknown>,
		value: PortableJson | undefined,
		path: string,
	) {
		if (typeof value === "string" && !map.has(value))
			warning("unresolved-reference", path);
	}
	function scope(value: PortableJson | undefined, path: string) {
		const selection = object(value ?? null);
		if (selection.mode === "one")
			softRef(workspaces, selection.id, `${path}.id`);
		if (selection.mode === "subset" && Array.isArray(selection.ids))
			selection.ids.forEach((id, i) => {
				softRef(workspaces, id, `${path}.ids[${i}]`);
			});
	}
	function filter(value: PortableJson, path: string) {
		const queue = [{ value, path }];
		while (queue.length) {
			const entry = queue.pop();
			if (!entry) break;
			const node = object(entry.value);
			if (Array.isArray(node.conditions)) {
				for (let i = node.conditions.length - 1; i >= 0; i--)
					queue.push({
						value: node.conditions[i],
						path: `${entry.path}.conditions[${i}]`,
					});
				continue;
			}
			const map =
				node.field === "list"
					? lists
					: node.field === "folder"
						? folders
						: node.field === "label"
							? labels
							: node.field === "assignee"
								? principals
								: undefined;
			if (!map) continue;
			const check = (id: PortableJson, valuePath: string) => {
				if (node.field === "assignee" && id === "me") return;
				softRef(map, id, valuePath);
			};
			if (Array.isArray(node.value))
				node.value.forEach((id, i) => {
					check(id, `${entry.path}.value[${i}]`);
				});
			else if (node.value !== undefined)
				check(node.value, `${entry.path}.value`);
		}
	}
	for (const collection of ["views", "dashboards"] as const) {
		data[collection].forEach((row, i) => {
			const path = `data.${collection}[${i}]`;
			requireRef(principals, row.ownerId, `${path}.ownerId`);
			if (row.scope === "personal") {
				own(row.ownerId, `${path}.ownerId`);
				if (row.workspaceId !== null)
					error("scope-workspace-mismatch", `${path}.workspaceId`);
			} else if (row.workspaceId === null)
				error("scope-workspace-mismatch", `${path}.workspaceId`);
			else requireRef(workspaces, row.workspaceId, `${path}.workspaceId`);
		});
	}
	data.views.forEach((row, i) => {
		filter(row.filter, `data.views[${i}].filter`);
		scope(
			object(row.display).workspaceScope,
			`data.views[${i}].display.workspaceScope`,
		);
	});
	data.dashboards.forEach((row, i) => {
		if (!Array.isArray(row.panels)) return;
		row.panels.forEach((value, j) => {
			const panel = object(value);
			const path = `data.dashboards[${i}].panels[${j}]`;
			const panelSource = object(panel.source ?? null);
			if (panelSource.kind === "view")
				softRef(views, panelSource.viewId, `${path}.source.viewId`);
			if (panelSource.kind === "inline") {
				filter(panelSource.filter ?? null, `${path}.source.filter`);
				scope(panelSource.workspaceScope, `${path}.source.workspaceScope`);
			}
			if (Array.isArray(panel.habitIds))
				panel.habitIds.forEach((id, k) => {
					if (typeof id === "string" && !isHabit(id))
						warning("unresolved-reference", `${path}.habitIds[${k}]`);
				});
		});
	});
	function homeRef(value: PortableJson | undefined, path: string) {
		if (typeof value !== "string") return;
		if (value.startsWith("dashboard:"))
			softRef(dashboards, value.slice(10), path);
		else if (!["today", "all-my-tasks", "assigned-to-me"].includes(value))
			softRef(views, value, path);
	}
	data.userPrefs.forEach((row, i) => {
		const path = `data.userPrefs[${i}]`;
		own(row.id, `${path}.id`);
		homeRef(row.homeViewRef, `${path}.homeViewRef`);
		if (Array.isArray(row.pinnedViews))
			row.pinnedViews.forEach((ref, j) => {
				homeRef(ref, `${path}.pinnedViews[${j}]`);
			});
		softRef(
			principals,
			object(row.escalationDefaults).fallbackUserId,
			`${path}.escalationDefaults.fallbackUserId`,
		);
	});
	data.focusSessions.forEach((row, i) => {
		own(row.userId, `data.focusSessions[${i}].userId`);
		if (row.taskId !== null)
			requireRef(tasks, row.taskId, `data.focusSessions[${i}].taskId`);
	});
	data.karma.forEach((row, i) => {
		own(row.userId, `data.karma[${i}].userId`);
	});
	data.karmaEvents.forEach((row, i) => {
		own(row.userId, `data.karmaEvents[${i}].userId`);
	});
	data.attachments.forEach((row, i) => {
		const path = `data.attachments[${i}]`;
		requireRef(workspaces, row.workspaceId, `${path}.workspaceId`);
		requireRef(principals, row.uploadedBy, `${path}.uploadedBy`);
		const parent =
			row.parentKind === "list"
				? lists.get(row.parentId)
				: row.parentKind === "task"
					? tasks.get(row.parentId)
					: comments.get(row.parentId);
		if (!parent) warning("orphan-attachment", `${path}.parentId`);
		else {
			const workspaceId =
				row.parentKind === "list"
					? lists.get(row.parentId)?.workspaceId
					: row.parentKind === "task"
						? taskWorkspace(row.parentId)
						: taskWorkspace(comments.get(row.parentId)?.taskId ?? "");
			sameWorkspace(row.workspaceId, workspaceId, `${path}.parentId`);
		}
	});
	return { valid: errors.length === 0, errors, warnings };
}
