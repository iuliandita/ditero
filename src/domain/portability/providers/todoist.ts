import { generateNKeysBetween } from "fractional-indexing";
import type { PortableExportV1, PortableRows } from "../v1.ts";
import {
	checkProviderText,
	PROVIDER_MAX_BYTES,
	PROVIDER_MAX_FIELD_BYTES,
	PROVIDER_MAX_ROWS,
	ProviderImportError,
	type ProviderImportOptions,
	providerCheckpoint,
	snapshotNamespace,
	TODOIST_ADAPTER,
	type TodoistConversionResult,
	todoistSourceUserId,
	validateProviderConversion,
} from "./common.ts";
import { parseProviderCsvCells } from "./csv-cells.ts";

export const TODOIST_HEADER = [
	"TYPE",
	"CONTENT",
	"DESCRIPTION",
	"PRIORITY",
	"INDENT",
	"AUTHOR",
	"RESPONSIBLE",
	"DATE",
	"DATE_LANG",
	"TIMEZONE",
	"DURATION",
	"DURATION_UNIT",
	"DEADLINE",
	"DEADLINE_LANG",
] as const;
export interface TodoistProjectNames {
	projectFolderName: string;
	unsectionedListName: string;
}
export async function todoistSnapshotSha256(
	bytes: Uint8Array,
	options: ProviderImportOptions = {},
): Promise<string> {
	const checkpoint = providerCheckpoint(options);
	checkpoint();
	if (bytes.byteLength > PROVIDER_MAX_BYTES)
		throw new ProviderImportError("byte-limit");
	if (!globalThis.crypto?.subtle)
		throw new ProviderImportError("secure-context-required");
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	checkpoint();
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
function names(input: TodoistProjectNames): TodoistProjectNames {
	if (
		!input ||
		typeof input !== "object" ||
		(Object.getPrototypeOf(input) !== Object.prototype &&
			Object.getPrototypeOf(input) !== null) ||
		Reflect.ownKeys(input).length !== 2
	)
		throw new ProviderImportError("invalid-metadata");
	const result: TodoistProjectNames = {
		projectFolderName: "",
		unsectionedListName: "",
	};
	for (const key of ["projectFolderName", "unsectionedListName"] as const) {
		const property = Object.getOwnPropertyDescriptor(input, key);
		if (
			!property ||
			!("value" in property) ||
			!property.enumerable ||
			typeof property.value !== "string" ||
			!property.value.trim()
		)
			throw new ProviderImportError("invalid-metadata");
		checkProviderText(property.value, 500);
		result[key] = property.value;
	}
	return result;
}
export async function parseTodoistProjectCsv(
	input: Uint8Array,
	options: ProviderImportOptions & TodoistProjectNames & { exportedAt: string },
): Promise<TodoistConversionResult> {
	if (
		!options ||
		typeof options !== "object" ||
		(Object.getPrototypeOf(options) !== Object.prototype &&
			Object.getPrototypeOf(options) !== null)
	)
		throw new ProviderImportError("invalid-metadata");
	for (const key of Reflect.ownKeys(options)) {
		const property = Object.getOwnPropertyDescriptor(options, key);
		if (
			typeof key !== "string" ||
			![
				"signal",
				"deadline",
				"exportedAt",
				"projectFolderName",
				"unsectionedListName",
			].includes(key) ||
			!property ||
			!("value" in property) ||
			!property.enumerable
		)
			throw new ProviderImportError("invalid-metadata");
	}
	const bounded = {
		...options,
		deadline: Math.min(
			options.deadline ?? Infinity,
			performance.now() + 15_000,
		),
	};
	const checkpoint = providerCheckpoint(bounded);
	checkpoint();
	const mapping = names({
		projectFolderName: options.projectFolderName,
		unsectionedListName: options.unsectionedListName,
	});
	const snapshotSha256 = await todoistSnapshotSha256(input, bounded);
	const namespace = snapshotNamespace(snapshotSha256);
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch {
		throw new ProviderImportError("invalid-encoding");
	}
	const cells = parseProviderCsvCells(text, checkpoint, 15);
	const header = cells[0];
	if (
		!header ||
		(header.length !== 14 && header.length !== 15) ||
		TODOIST_HEADER.some((name, index) => header[index] !== name) ||
		(header.length === 15 && header[14] !== "IS_COLLAPSED")
	)
		throw new ProviderImportError("invalid-csv");
	const prefix = `todoist:1:${namespace}`;
	const owner = todoistSourceUserId(namespace);
	const workspace = `${prefix}:workspace`;
	const folder = `${prefix}:folder:project`;
	const sourceLists = [
		{ id: `${prefix}:list:unsectioned`, title: mapping.unsectionedListName },
	];
	const pending: {
		id: string;
		listId: string;
		parentId: string | null;
		title: string;
		notes: string | null;
		priority: number;
	}[] = [];
	let listId = sourceLists[0]?.id;
	let parentId: string | null = null;
	if (!listId) throw new ProviderImportError("invalid-result");
	for (const [index, fields] of cells.slice(1).entries()) {
		checkpoint();
		const row = index + 2;
		if (fields.every((value) => value === "")) continue;
		if (fields.length !== header.length)
			throw new ProviderImportError("invalid-csv", row);
		const [type, content, description, priority, indent] = fields;
		if (type === "meta") {
			if (!/^view_style=(list|board)$/.test(content ?? ""))
				throw new ProviderImportError("unsupported-content", row);
			continue;
		}
		if (type === "note") continue;
		if (type !== "task" && type !== "section")
			throw new ProviderImportError("unsupported-content", row);
		if (!content?.trim()) throw new ProviderImportError("invalid-row", row);
		checkProviderText(content, 500, row);
		if (type === "section") {
			listId = `${prefix}:list:record:${row}`;
			sourceLists.push({ id: listId, title: content });
			parentId = null;
			continue;
		}
		if (priority !== "" && !/^[1-4]$/.test(priority ?? ""))
			throw new ProviderImportError("invalid-row", row);
		if (indent !== "" && indent !== "1" && indent !== "2")
			throw new ProviderImportError("invalid-graph", row);
		if (indent === "2" && parentId === null)
			throw new ProviderImportError("invalid-graph", row);
		checkProviderText(description ?? "", PROVIDER_MAX_FIELD_BYTES - 1, row);
		const id = `${prefix}:task:record:${row}`;
		pending.push({
			id,
			listId,
			parentId: indent === "2" ? parentId : null,
			title: content,
			notes: description || null,
			priority: 4 - Number(priority || "1"),
		});
		if (indent !== "2") parentId = id;
	}
	if (pending.length + sourceLists.length + 4 > PROVIDER_MAX_ROWS)
		throw new ProviderImportError("row-limit");
	const groupedRows = new Map<string, typeof pending>();
	for (const task of pending) {
		checkpoint();
		const group = groupedRows.get(task.listId) ?? [];
		group.push(task);
		groupedRows.set(task.listId, group);
	}
	const listKeys = generateNKeysBetween(null, null, sourceLists.length);
	const tasks: PortableRows["tasks"][] = [];
	for (const list of sourceLists) {
		checkpoint();
		const grouped = groupedRows.get(list.id) ?? [];
		const keys = generateNKeysBetween(null, null, grouped.length);
		for (const [index, task] of grouped.entries()) {
			checkpoint();
			const sortKey = keys[index];
			if (!sortKey) throw new ProviderImportError("invalid-result");
			tasks.push({
				...task,
				done: false,
				completedAt: null,
				dueAt: null,
				dueAllDay: false,
				sortKey,
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
			});
		}
	}
	const document: PortableExportV1 = {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: options.exportedAt,
		sourceUserId: owner,
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "current-state-and-habit-logs",
		},
		data: {
			principals: [{ id: owner, name: "Untrusted migration owner" }],
			workspaces: [
				{
					id: workspace,
					name: "Todoist project migration",
					ownerId: owner,
					kind: "personal",
				},
			],
			memberships: [
				{
					id: `${prefix}:membership`,
					workspaceId: workspace,
					userId: owner,
					role: "owner",
				},
			],
			folders: [
				{
					id: folder,
					workspaceId: workspace,
					name: mapping.projectFolderName,
					sortKey: "a0",
				},
			],
			lists: sourceLists.map((list, index) => ({
				...list,
				workspaceId: workspace,
				ownerId: owner,
				kind: "tasks",
				icon: null,
				folderId: folder,
				sortKey: listKeys[index] ?? "",
				completedDisplay: "sink",
			})),
			tasks,
			labels: [],
			taskLabels: [],
			assignments: [],
			comments: [],
			templates: [],
			habitLogs: [],
			focusSessions: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			karma: [],
			karmaEvents: [],
			attachments: [],
		},
	};
	const result = validateProviderConversion(
		{
			adapter: TODOIST_ADAPTER,
			adapterVersion: 1,
			sourceNamespace: namespace,
			identityMode: "snapshot-rows",
			snapshotSha256,
			...mapping,
			document,
			findings: [{ code: "untrusted-migration-owner", path: "sourceUserId" }],
		},
		bounded,
	);
	if (result.adapter !== TODOIST_ADAPTER)
		throw new ProviderImportError("invalid-result");
	checkpoint();
	return result;
}
