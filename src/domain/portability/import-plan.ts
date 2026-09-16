import { validateImportGraph } from "./graph.ts";
import type { PortableExportV1, PortableJson, PortableRows } from "./v1.ts";

export type ImportMappings = {
	workspaces: Record<string, string>;
	principals: Record<string, string | null>;
};
export interface ImportPlanItem {
	ordinal: number;
	collection: keyof PortableRows;
	sourceId: string;
	sourceKey: string;
	itemDigest: string;
	targetId: string | null;
	disposition: "ensure" | "ignored" | "blocked";
	payload: PortableJson;
	codes: string[];
}
export interface ImportPlanReport {
	plannerVersion: 1;
	applySupported: false;
	counts: { ensure: number; ignored: number; blocked: number };
	findings: { code: string; path: string }[];
}
export class ImportPlanError extends Error {
	constructor(
		readonly code:
			| "invalid-graph"
			| "invalid-mappings"
			| "finding-limit"
			| "planning-timeout"
			| "planning-cancelled",
	) {
		super(code);
		this.name = "ImportPlanError";
	}
}

type Collection = keyof PortableRows;
type JsonObject = Record<string, PortableJson>;
function object(value: PortableJson): JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}
function canonical(value: PortableJson, checkpoint?: () => void): string {
	checkpoint?.();
	if (Array.isArray(value))
		return `[${value.map((child) => canonical(child, checkpoint)).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonical(value[key], checkpoint)}`,
			)
			.join(",")}}`;
	return JSON.stringify(value);
}
async function hash(
	domain: string,
	value: PortableJson,
	checkpoint: () => void,
): Promise<string> {
	checkpoint();
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonical([domain, value], checkpoint)),
	);
	checkpoint();
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
function rowId(row: PortableRows[Collection]): string {
	return "id" in row ? row.id : row.userId;
}

async function settleHashes<T>(pending: Promise<T>[]): Promise<T[]> {
	// Keep request admission until the uncancellable Web Crypto work has settled.
	const results = await Promise.allSettled(pending);
	return results.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
}

// Input structure and resource bounds must first pass parsePortableExportV1.
export async function buildImportPlan(
	document: PortableExportV1,
	context: {
		ownerUserId: string;
		sourceId: string;
		mappings: ImportMappings;
		signal?: AbortSignal;
		deadline?: number;
	},
) {
	const deadline = context.deadline ?? performance.now() + 15_000;
	const checkpoint = () => {
		if (context.signal?.aborted)
			throw new ImportPlanError("planning-cancelled");
		if (performance.now() >= deadline)
			throw new ImportPlanError("planning-timeout");
	};
	const digest = (domain: string, value: PortableJson) =>
		hash(domain, value, checkpoint);
	checkpoint();
	const graph = validateImportGraph(document);
	checkpoint();
	if (!graph.valid) throw new ImportPlanError("invalid-graph");
	const { ownerUserId, sourceId, mappings } = context;
	function exact(
		rows: { id: string }[],
		mapping: Record<string, string | null>,
		nullable: boolean,
	) {
		return (
			Object.keys(mapping).length === rows.length &&
			rows.every(
				(row) =>
					Object.hasOwn(mapping, row.id) &&
					((nullable && mapping[row.id] === null) ||
						(typeof mapping[row.id] === "string" && mapping[row.id]?.length)),
			)
		);
	}
	if (
		!ownerUserId ||
		!sourceId ||
		!exact(document.data.workspaces, mappings.workspaces, false) ||
		!exact(document.data.principals, mappings.principals, true) ||
		mappings.principals[document.sourceUserId] !== ownerUserId
	)
		throw new ImportPlanError("invalid-mappings");
	const collections: Collection[] = [
		"principals",
		"workspaces",
		"memberships",
		"folders",
		"lists",
		"labels",
		"templates",
		"tasks",
		"taskLabels",
		"assignments",
		"comments",
		"habitLogs",
		"focusSessions",
		"views",
		"dashboards",
		"userPrefs",
		"karma",
		"karmaEvents",
		"attachments",
	];
	const byId = (a: PortableRows[Collection], b: PortableRows[Collection]) =>
		rowId(a) < rowId(b) ? -1 : rowId(a) > rowId(b) ? 1 : 0;
	const normalizedData = Object.fromEntries(
		collections.map((collection) => [
			collection,
			[...document.data[collection]].sort(byId),
		]),
	);
	const entries = collections.flatMap((collection) =>
		[...document.data[collection]]
			.sort((a, b) => {
				// Graph validation guarantees that subtasks have only root parents.
				if (collection === "tasks" && "parentId" in a && "parentId" in b) {
					const depth =
						Number(a.parentId !== null) - Number(b.parentId !== null);
					if (depth) return depth;
				}
				return byId(a, b);
			})
			.map((row) => ({ collection, row, id: rowId(row) })),
	);
	const { exportedAt: _exportedAt, ...content } = document;
	const documentDigest = await digest("ditero-import-document-v1", {
		...content,
		data: normalizedData,
	} as PortableJson);
	const mappingDigest = await digest("ditero-import-mappings-v1", mappings);
	const planDigest = await digest("ditero-import-plan-v1", [
		ownerUserId,
		sourceId,
		documentDigest,
		mappingDigest,
	]);
	const items: ImportPlanItem[] = [];
	const indexes = new Map<Collection, Map<string, ImportPlanItem>>();
	for (const collection of collections) indexes.set(collection, new Map());
	for (let offset = 0; offset < entries.length; offset += 256) {
		checkpoint();
		const batch = await settleHashes(
			entries
				.slice(offset, offset + 256)
				.map(async (entry, index): Promise<ImportPlanItem> => {
					const identity = [ownerUserId, sourceId, entry.collection, entry.id];
					const [sourceKey, targetId] = await settleHashes([
						digest("ditero-import-source-key-v1", identity),
						digest("ditero-import-target-id-v1", identity),
					]);
					return {
						ordinal: offset + index,
						collection: entry.collection,
						sourceId: entry.id,
						sourceKey,
						itemDigest: "",
						targetId,
						disposition: "ensure",
						payload: structuredClone(entry.row) as PortableJson,
						codes: [],
					};
				}),
		);
		for (const item of batch) {
			items.push(item);
			indexes.get(item.collection)?.set(item.sourceId, item);
		}
	}
	const report: ImportPlanReport = {
		plannerVersion: 1,
		applySupported: false,
		counts: { ensure: 0, ignored: 0, blocked: 0 },
		findings: [],
	};
	const dependents = new Map<ImportPlanItem, Set<ImportPlanItem>>();
	function block(item: ImportPlanItem, code: string) {
		item.disposition = "blocked";
		if (!item.codes.includes(code)) item.codes.push(code);
	}
	const warningItems = new Set<ImportPlanItem>();
	for (const warning of graph.warnings) {
		const match = /^data\.([A-Za-z]+)\[(\d+)\]/.exec(warning.path);
		if (!match) continue;
		const collection = match[1] as Collection;
		const row = document.data[collection][Number(match[2])];
		const item = indexes.get(collection)?.get(rowId(row));
		if (item) warningItems.add(item);
	}
	for (const item of items) {
		checkpoint();
		const payload = object(item.payload);
		const collection = item.collection;
		if (
			["principals", "workspaces", "memberships", "attachments"].includes(
				collection,
			)
		) {
			item.disposition = "ignored";
			item.targetId = null;
			item.codes.push(
				collection === "attachments"
					? "attachment-content-excluded"
					: "authority-not-imported",
			);
			continue;
		}
		if (warningItems.has(item)) block(item, "unresolved-reference");
		if (
			["userPrefs", "karma", "karmaEvents", "habitLogs"].includes(collection)
		) {
			block(item, "personal-state-merge-policy-required");
			continue;
		}
		if (
			(collection === "comments" &&
				payload.authorId !== document.sourceUserId) ||
			(collection === "templates" &&
				payload.createdBy !== document.sourceUserId)
		) {
			block(item, "historical-author-not-imported");
			continue;
		}
		function reference(target: Collection, value: PortableJson): PortableJson {
			if (value === null) return null;
			if (Array.isArray(value)) return value.map((id) => reference(target, id));
			if (typeof value !== "string") {
				block(item, "unresolved-reference");
				return value;
			}
			if (target === "principals" || target === "workspaces") {
				const mapping =
					target === "principals" ? mappings.principals : mappings.workspaces;
				if (!Object.hasOwn(mapping, value) || mapping[value] === null) {
					block(item, "unmapped-reference");
					return value;
				}
				return mapping[value];
			}
			const dependency = indexes.get(target)?.get(value);
			if (!dependency) {
				block(item, "unresolved-reference");
				return value;
			}
			const users = dependents.get(dependency) ?? new Set<ImportPlanItem>();
			users.add(item);
			dependents.set(dependency, users);
			return dependency.targetId;
		}
		const fields: Record<string, Collection> = {
			workspaceId: "workspaces",
			ownerId: "principals",
			createdBy: "principals",
			authorId: "principals",
			userId: "principals",
			fallbackUserId: "principals",
			folderId: "folders",
			listId: "lists",
			taskId: "tasks",
			parentId: "tasks",
			habitId: "tasks",
			labelId: "labels",
		};
		for (const [field, target] of Object.entries(fields)) {
			if (Object.hasOwn(payload, field))
				payload[field] = reference(target, payload[field]);
		}
		payload.id = item.targetId;
		function filter(value: PortableJson) {
			const node = object(value);
			if (Array.isArray(node.conditions)) {
				for (const child of node.conditions) filter(child);
				return;
			}
			const field = node.field;
			const target =
				field === "list"
					? "lists"
					: field === "folder"
						? "folders"
						: field === "label"
							? "labels"
							: field === "assignee"
								? "principals"
								: null;
			if (target && !(field === "assignee" && node.value === "me"))
				node.value = reference(target, node.value);
		}
		function scope(value: PortableJson) {
			const node = object(value);
			if (node.mode === "one") node.id = reference("workspaces", node.id);
			if (node.mode === "subset") node.ids = reference("workspaces", node.ids);
		}
		if (collection === "views") {
			filter(payload.filter);
			scope(object(payload.display).workspaceScope);
		}
		if (collection === "dashboards" && Array.isArray(payload.panels)) {
			for (const value of payload.panels) {
				const panel = object(value);
				const source = object(panel.source);
				if (source.kind === "view")
					source.viewId = reference("views", source.viewId);
				if (source.kind === "inline") {
					filter(source.filter);
					scope(source.workspaceScope);
				}
				if (panel.habitIds) panel.habitIds = reference("tasks", panel.habitIds);
			}
		}
	}
	// Mapping multiple source workspaces/users onto one target can collapse unique keys.
	const unique = new Map<string, ImportPlanItem>();
	for (const item of items) {
		if (item.disposition !== "ensure") continue;
		const p = object(item.payload);
		const key =
			item.collection === "labels"
				? canonical(["labels", p.workspaceId, p.name])
				: item.collection === "assignments"
					? canonical(["assignments", p.taskId, p.userId])
					: null;
		if (key === null) continue;
		const previous = unique.get(key);
		if (previous) {
			block(previous, "mapping-conflict");
			block(item, "mapping-conflict");
		} else unique.set(key, item);
	}
	const queue = items.filter((item) => item.disposition === "blocked");
	for (let i = 0; i < queue.length; i++) {
		for (const dependent of dependents.get(queue[i]) ?? []) {
			if (dependent.disposition !== "ensure") continue;
			block(dependent, "blocked-dependency");
			queue.push(dependent);
		}
	}
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item.disposition === "blocked") {
			item.targetId = null;
			item.payload = structuredClone(entries[i].row) as PortableJson;
		}
		report.counts[item.disposition]++;
		for (const code of item.codes) {
			if (report.findings.length === 1000)
				throw new ImportPlanError("finding-limit");
			report.findings.push({ code, path: `items[${item.ordinal}]` });
		}
	}
	for (let offset = 0; offset < items.length; offset += 256) {
		checkpoint();
		await settleHashes(
			items.slice(offset, offset + 256).map(async (item) => {
				item.itemDigest = await digest("ditero-import-item-v1", {
					collection: item.collection,
					sourceKey: item.sourceKey,
					targetId: item.targetId,
					disposition: item.disposition,
					payload: item.payload,
					codes: item.codes,
				});
			}),
		);
	}
	checkpoint();
	return { documentDigest, mappingDigest, planDigest, items, report };
}
