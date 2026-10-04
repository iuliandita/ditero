import { generateNKeysBetween } from "fractional-indexing";
import { z } from "zod";
import type { PortableExportV1, PortableRows } from "../v1.ts";
import {
	CSV_ADAPTER,
	CSV_ADAPTER_VERSION,
	checkProviderText,
	csvSourceUserId,
	PROVIDER_MAX_BYTES,
	PROVIDER_MAX_FIELD_BYTES,
	PROVIDER_MAX_ROWS,
	type ProviderConversionResult,
	ProviderImportError,
	type ProviderImportOptions,
	providerCheckpoint,
	validateProviderConversion,
} from "./common.ts";
import { parseProviderCsvCells } from "./csv-cells.ts";

export const CSV_HEADER = [
	"csv_version",
	"text_encoding",
	"source_namespace",
	"list_id",
	"list_title",
	"task_id",
	"parent_task_id",
	"title",
	"notes",
	"done",
	"completed_at",
	"due_at",
	"due_all_day",
	"priority",
	"sort_index",
] as const;

export type CsvTextEncoding = "plain" | "apostrophe-v1";
const dateSchema = z.iso.datetime({ offset: true });
const uuidSchema = z.uuid();
const encoder = new TextEncoder();

interface CsvRow {
	listId: string;
	id: string;
	parentId: string | null;
	title: string;
	notes: string | null;
	done: boolean;
	completedAt: string | null;
	dueAt: string | null;
	dueAllDay: boolean;
	priority: number;
	sortIndex: number;
}

function fail(
	code: ConstructorParameters<typeof ProviderImportError>[0],
	row?: number,
): never {
	throw new ProviderImportError(code, row);
}

function date(value: string, row: number): string | null {
	if (!value) return null;
	if (!dateSchema.safeParse(value).success) fail("invalid-date", row);
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) fail("invalid-date", row);
	return parsed.toISOString();
}

function boolean(value: string, row: number): boolean {
	if (value !== "true" && value !== "false") fail("invalid-row", row);
	return value === "true";
}

function id(value: string, row: number): string {
	checkProviderText(value, 512, row);
	if (!value || /^\s|\s$/.test(value)) fail("invalid-row", row);
	return value;
}

function freeText(
	value: string,
	encoding: CsvTextEncoding,
	max: number,
	row: number,
): string {
	if (encoding === "apostrophe-v1" && value) {
		if (!value.startsWith("'")) fail("invalid-row", row);
		value = value.slice(1);
		if (!value) fail("invalid-row", row);
	}
	checkProviderText(value, max, row);
	return value;
}

function sourceId(namespace: string, kind: "list" | "task", value: string) {
	return `csv:1:${namespace}:${kind}:${value}`;
}

export function parseTaskCsv(
	input: Uint8Array,
	options: ProviderImportOptions & { exportedAt: string },
): ProviderConversionResult {
	options = {
		...options,
		deadline: Math.min(
			options.deadline ?? Infinity,
			performance.now() + 15_000,
		),
	};
	const checkpoint = providerCheckpoint(options);
	checkpoint();
	if (input.byteLength > PROVIDER_MAX_BYTES) fail("byte-limit");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(input);
	} catch {
		fail("invalid-encoding");
	}
	const cells = parseProviderCsvCells(text, checkpoint, CSV_HEADER.length);
	if (
		cells[0]?.length !== CSV_HEADER.length ||
		CSV_HEADER.some((header, index) => cells[0]?.[index] !== header) ||
		cells.length < 2
	)
		fail("invalid-csv");
	let namespace: string | undefined;
	let encoding: CsvTextEncoding | undefined;
	const ids = new Set<string>();
	const titles = new Map<string, string>();
	const rows: CsvRow[] = [];
	for (const [index, fields] of cells.slice(1).entries()) {
		checkpoint();
		const row = index + 2;
		if (fields.length !== CSV_HEADER.length) fail("invalid-csv", row);
		const [
			version,
			textEncoding,
			sourceNamespace,
			list,
			listTitle,
			task,
			parent,
			title,
			notes,
			done,
			completedAt,
			dueAt,
			dueAllDay,
			priority,
			sortIndex,
		] = fields;
		if (
			version !== "1" ||
			(textEncoding !== "plain" && textEncoding !== "apostrophe-v1") ||
			!sourceNamespace ||
			!uuidSchema.safeParse(sourceNamespace).success
		)
			fail("invalid-metadata", row);
		const canonicalNamespace = sourceNamespace.toLowerCase();
		if (
			(namespace && namespace !== canonicalNamespace) ||
			(encoding && encoding !== textEncoding)
		)
			fail("invalid-metadata", row);
		namespace = canonicalNamespace;
		encoding = textEncoding;
		const listId = id(freeText(list ?? "", encoding, 512, row), row);
		const taskId = id(freeText(task ?? "", encoding, 512, row), row);
		if (ids.has(taskId)) fail("invalid-row", row);
		ids.add(taskId);
		const name = freeText(listTitle ?? "", encoding, 500, row);
		const taskTitle = freeText(title ?? "", encoding, 500, row);
		if (!name.trim() || !taskTitle.trim()) fail("invalid-row", row);
		if (titles.has(listId) && titles.get(listId) !== name)
			fail("invalid-metadata", row);
		titles.set(listId, name);
		if (
			!/^[0-3]$/.test(priority ?? "") ||
			!/^(0|[1-9]\d{0,8})$/.test(sortIndex ?? "")
		)
			fail("invalid-row", row);
		const parsed: CsvRow = {
			listId,
			id: taskId,
			parentId: parent ? id(freeText(parent, encoding, 512, row), row) : null,
			title: taskTitle,
			notes:
				freeText(notes ?? "", encoding, PROVIDER_MAX_FIELD_BYTES - 1, row) ||
				null,
			done: boolean(done ?? "", row),
			completedAt: date(completedAt ?? "", row),
			dueAt: date(dueAt ?? "", row),
			dueAllDay: boolean(dueAllDay ?? "", row),
			priority: Number(priority),
			sortIndex: Number(sortIndex),
		};
		if (
			(!parsed.done && parsed.completedAt) ||
			(parsed.dueAllDay && !parsed.dueAt)
		)
			fail("invalid-row", row);
		rows.push(parsed);
	}
	if (!namespace) fail("invalid-metadata");
	if (rows.length + titles.size + 3 > PROVIDER_MAX_ROWS) fail("row-limit");
	const owner = csvSourceUserId(namespace);
	const workspace = `csv:1:${namespace}:workspace`;
	const orderedLists = [...titles.entries()].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	const listKeys = generateNKeysBetween(null, null, orderedLists.length);
	const orderedRows = [...rows].sort((a, b) =>
		a.listId < b.listId
			? -1
			: a.listId > b.listId
				? 1
				: a.sortIndex - b.sortIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
	);
	const tasks: PortableRows["tasks"][] = [];
	const groupedRows = new Map<string, CsvRow[]>();
	for (const row of orderedRows) {
		const group = groupedRows.get(row.listId) ?? [];
		group.push(row);
		groupedRows.set(row.listId, group);
	}
	for (const [listId] of orderedLists) {
		checkpoint();
		const listRows = groupedRows.get(listId) ?? [];
		const keys = generateNKeysBetween(null, null, listRows.length);
		for (const [index, row] of listRows.entries()) {
			checkpoint();
			tasks.push({
				id: sourceId(namespace, "task", row.id),
				listId: sourceId(namespace, "list", listId),
				title: row.title,
				done: row.done,
				notes: row.notes,
				dueAt: row.dueAt,
				dueAllDay: row.dueAllDay,
				priority: row.priority,
				completedAt: row.completedAt,
				sortKey: keys[index] ?? fail("invalid-result"),
				parentId: row.parentId
					? sourceId(namespace, "task", row.parentId)
					: null,
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
					name: "CSV migration",
					ownerId: owner,
					kind: "personal",
				},
			],
			memberships: [
				{
					id: `csv:1:${namespace}:membership`,
					userId: owner,
					workspaceId: workspace,
					role: "owner",
				},
			],
			lists: orderedLists.map(([listId, title], index) => ({
				id: sourceId(namespace, "list", listId),
				workspaceId: workspace,
				ownerId: owner,
				title,
				kind: "tasks",
				icon: null,
				folderId: null,
				sortKey: listKeys[index] ?? fail("invalid-result"),
				completedDisplay: "sink",
			})),
			tasks,
			folders: [],
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
	return validateProviderConversion(
		{
			adapter: CSV_ADAPTER,
			adapterVersion: CSV_ADAPTER_VERSION,
			sourceNamespace: namespace,
			identityMode: "stable-ids",
			document,
			findings: [{ code: "untrusted-migration-owner", path: "sourceUserId" }],
		},
		options,
	);
}

function quote(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}

export function exportTaskCsv(
	input: ProviderConversionResult,
	options: ProviderImportOptions = {},
): Uint8Array {
	options = {
		...options,
		deadline: Math.min(
			options.deadline ?? Infinity,
			performance.now() + 15_000,
		),
	};
	const checkpoint = providerCheckpoint(options);
	const result = validateProviderConversion(input, options);
	const encoding = "apostrophe-v1";
	const free = (value: string) => (value ? `'${value}` : value);
	const namespace = result.sourceNamespace;
	const data = result.document.data;
	const original = (value: string, kind: "task" | "list") => {
		const prefix = sourceId(namespace, kind, "");
		if (!value.startsWith(prefix)) fail("invalid-result");
		return value.slice(prefix.length);
	};
	const lines = [CSV_HEADER.join(",")];
	let bytes = encoder.encode(`${lines[0]}\r\n`).byteLength;
	const groupedTasks = new Map<string, PortableRows["tasks"][]>();
	for (const task of data.tasks) {
		const group = groupedTasks.get(task.listId) ?? [];
		group.push(task);
		groupedTasks.set(task.listId, group);
	}
	for (const list of data.lists) {
		checkpoint();
		const tasks = (groupedTasks.get(list.id) ?? []).sort((a, b) =>
			a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0,
		);
		for (const [index, task] of tasks.entries()) {
			checkpoint();
			const fields = [
				"1",
				encoding,
				namespace,
				free(original(list.id, "list")),
				free(list.title),
				free(original(task.id, "task")),
				task.parentId ? free(original(task.parentId, "task")) : "",
				free(task.title),
				free(task.notes ?? ""),
				String(task.done),
				task.completedAt ?? "",
				task.dueAt ?? "",
				String(task.dueAllDay),
				String(task.priority),
				String(index),
			];
			const line = fields.map(quote).join(",");
			bytes += encoder.encode(`${line}\r\n`).byteLength;
			if (bytes > PROVIDER_MAX_BYTES) fail("byte-limit");
			lines.push(line);
		}
	}
	const bytesOut = encoder.encode(`${lines.join("\r\n")}\r\n`);
	// Refuse lossy or forged conversion results rather than exporting a subset.
	const roundTrip = parseTaskCsv(bytesOut, {
		...options,
		exportedAt: result.document.exportedAt,
	});
	if (JSON.stringify(roundTrip.document) !== JSON.stringify(result.document))
		fail("unsupported-content");
	checkpoint();
	return bytesOut;
}
