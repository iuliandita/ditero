import { z } from "zod";
import { validateImportGraph } from "../graph.ts";
import type { PortableExportV1 } from "../v1.ts";
import {
	PortableExportValidationError,
	parsePortableExportV1,
} from "../validate.ts";

export const PROVIDER_MAX_BYTES = 32 * 1024 * 1024;
export const PROVIDER_MAX_ROWS = 50_000;
export const PROVIDER_MAX_FIELD_BYTES = 32 * 1024;
export const CSV_ADAPTER = "ditero-csv";
export const CSV_ADAPTER_VERSION = 1;

export const TODOIST_ADAPTER = "todoist-project-csv";
export const TODOIST_ADAPTER_VERSION = 1;
export const TODOIST_V1_EXCLUSIONS = Object.freeze([
	"dates",
	"recurrence",
	"deadlines",
	"durations",
	"authors",
	"assignments",
	"comments",
	"labels",
	"templates",
	"attachments",
	"history",
	"completion-state",
	"reminders",
	"personal-state",
	"section-project-descriptions",
	"view-settings",
	"shopping-fields",
	"task-creation-times",
	"urgency",
] as const);

export const TRELLO_ADAPTER = "trello-board-json";
export const TRELLO_ADAPTER_VERSION = 1;
// Binding constant: the fixed order is part of the contract.
export const TRELLO_V1_EXCLUSIONS = Object.freeze([
	"dates",
	"completion-state",
	"recurrence",
	"authors",
	"assignments",
	"comments",
	"labels",
	"checklists",
	"attachments",
	"history",
	"reminders",
	"personal-state",
	"custom-fields",
	"covers",
	"stickers",
	"view-settings",
	"plugin-data",
	"task-creation-times",
	"shopping-fields",
	"urgency",
	"board-descriptions",
] as const);
export const TRELLO_NAMESPACE_DOMAIN = "ditero-trello-board-v1\n";
export function snapshotNamespace(sha256: string): string {
	if (!/^[0-9a-f]{64}$/.test(sha256))
		throw new ProviderImportError("invalid-metadata");
	const hex = `${sha256.slice(0, 12)}8${sha256.slice(13, 16)}${((Number.parseInt(sha256[16] ?? "", 16) & 3) | 8).toString(16)}${sha256.slice(17, 32)}`;
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function todoistSourceUserId(namespace: string): string {
	return `migration:todoist-project-csv:1:${namespace}:owner`;
}
export function trelloSourceUserId(namespace: string): string {
	return `migration:trello-board-json:1:${namespace}:owner`;
}

export type ProviderImportCode =
	| "byte-limit"
	| "row-limit"
	| "field-limit"
	| "invalid-encoding"
	| "invalid-csv"
	| "invalid-json"
	| "invalid-metadata"
	| "invalid-row"
	| "invalid-date"
	| "invalid-graph"
	| "invalid-result"
	| "unsupported-content"
	| "secure-context-required"
	| "cancelled"
	| "timeout";

export class ProviderImportError extends Error {
	constructor(
		readonly code: ProviderImportCode,
		readonly row?: number,
	) {
		super(code);
		this.name = "ProviderImportError";
	}
}

export interface ProviderImportOptions {
	signal?: AbortSignal;
	deadline?: number;
}

export function providerCheckpoint(options: ProviderImportOptions = {}) {
	const deadline = Math.min(
		options.deadline ?? Number.POSITIVE_INFINITY,
		performance.now() + 15_000,
	);
	if (Number.isNaN(deadline)) throw new ProviderImportError("timeout");
	return () => {
		if (options.signal?.aborted) throw new ProviderImportError("cancelled");
		if (performance.now() >= deadline) throw new ProviderImportError("timeout");
	};
}

export function checkProviderText(
	value: string,
	maxBytes: number,
	row?: number,
) {
	if (value.includes("\u0000") || !value.isWellFormed())
		throw new ProviderImportError("invalid-row", row);
	if (new TextEncoder().encode(value).byteLength > maxBytes)
		throw new ProviderImportError("field-limit", row);
}

export function csvSourceUserId(namespace: string): string {
	// Operational ownership for mapping only; this is no claim of authorship.
	return `migration:ditero-csv:1:${namespace}:owner`;
}

export interface CsvConversionResult {
	adapter: typeof CSV_ADAPTER;
	adapterVersion: typeof CSV_ADAPTER_VERSION;
	sourceNamespace: string;
	identityMode: "stable-ids";
	document: PortableExportV1;
	findings: { code: "untrusted-migration-owner"; path: "sourceUserId" }[];
}

export interface TodoistConversionResult
	extends Omit<CsvConversionResult, "adapter" | "identityMode"> {
	adapter: typeof TODOIST_ADAPTER;
	identityMode: "snapshot-rows";
	snapshotSha256: string;
	projectFolderName: string;
	unsectionedListName: string;
}
export interface TrelloConversionResult
	extends Omit<CsvConversionResult, "adapter"> {
	adapter: typeof TRELLO_ADAPTER;
	snapshotSha256: string;
	// SHA-256 of the domain-separated canonical board id; the namespace derives from it.
	boardIdSha256: string;
}
export type ProviderConversionResult =
	| CsvConversionResult
	| TodoistConversionResult
	| TrelloConversionResult;

const csvResultSchema = z.strictObject({
	adapter: z.literal(CSV_ADAPTER),
	adapterVersion: z.literal(CSV_ADAPTER_VERSION),
	sourceNamespace: z.uuid(),
	identityMode: z.literal("stable-ids"),
	document: z.unknown(),
	findings: z
		.array(
			z.strictObject({
				code: z.literal("untrusted-migration-owner"),
				path: z.literal("sourceUserId"),
			}),
		)
		.length(1),
});

const todoistResultSchema = z.strictObject({
	adapter: z.literal(TODOIST_ADAPTER),
	adapterVersion: z.literal(1),
	sourceNamespace: z.uuid(),
	identityMode: z.literal("snapshot-rows"),
	snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
	projectFolderName: z.string().min(1),
	unsectionedListName: z.string().min(1),
	document: z.unknown(),
	findings: csvResultSchema.shape.findings,
});
const trelloResultSchema = z.strictObject({
	adapter: z.literal(TRELLO_ADAPTER),
	adapterVersion: z.literal(TRELLO_ADAPTER_VERSION),
	sourceNamespace: z.uuid(),
	identityMode: z.literal("stable-ids"),
	snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
	boardIdSha256: z.string().regex(/^[0-9a-f]{64}$/),
	document: z.unknown(),
	findings: csvResultSchema.shape.findings,
});
const resultSchema = z.discriminatedUnion("adapter", [
	csvResultSchema,
	todoistResultSchema,
	trelloResultSchema,
]);

function boundedDocumentJson(
	input: unknown,
	checkpoint: () => void,
	countBytes = true,
): string {
	const pending: { iterator: Iterator<unknown>; depth: number }[] = [
		{ iterator: [input][Symbol.iterator](), depth: 0 },
	];
	let bytes = 0;
	let visited = 0;
	const add = (count: number) => {
		bytes += count;
		if (countBytes && bytes > PROVIDER_MAX_BYTES)
			throw new ProviderImportError("byte-limit");
	};
	while (pending.length) {
		checkpoint();
		const frame = pending[pending.length - 1];
		if (!frame) break;
		const next = frame.iterator.next();
		if (next.done) {
			pending.pop();
			continue;
		}
		if (++visited > 2_000_000 || frame.depth > 32)
			throw new ProviderImportError("invalid-result");
		const { value } = next;
		if (typeof value === "string") {
			checkProviderText(value, PROVIDER_MAX_FIELD_BYTES);
			add(new TextEncoder().encode(JSON.stringify(value)).byteLength);
		} else if (
			value === null ||
			typeof value === "boolean" ||
			(typeof value === "number" && Number.isFinite(value))
		) {
			add(String(value).length);
		} else if (Array.isArray(value)) {
			if (value.length > PROVIDER_MAX_ROWS)
				throw new ProviderImportError("row-limit");
			if (
				Object.getPrototypeOf(value) !== Array.prototype ||
				Reflect.ownKeys(value).length !== value.length + 1
			)
				throw new ProviderImportError("invalid-result");
			add(2 + Math.max(0, value.length - 1));
			const elements: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				const property = Object.getOwnPropertyDescriptor(value, String(index));
				if (!property || !("value" in property) || !property.enumerable)
					throw new ProviderImportError("invalid-result");
				elements.push(property.value);
			}
			pending.push({ iterator: elements.values(), depth: frame.depth + 1 });
		} else if (
			value &&
			typeof value === "object" &&
			(Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null)
		) {
			const keys = Object.keys(value);
			if (Reflect.ownKeys(value).length !== keys.length)
				throw new ProviderImportError("invalid-result");
			if (keys.length > 64) throw new ProviderImportError("invalid-result");
			add(2 + Math.max(0, keys.length - 1));
			function* children() {
				for (const key of keys) {
					checkProviderText(key, 512);
					const property = Object.getOwnPropertyDescriptor(value, key);
					if (!property || !("value" in property) || !property.enumerable)
						throw new ProviderImportError("invalid-result");
					add(new TextEncoder().encode(JSON.stringify(key)).byteLength + 1);
					yield property.value;
				}
			}
			pending.push({ iterator: children(), depth: frame.depth + 1 });
		} else throw new ProviderImportError("invalid-result");
	}
	return countBytes ? JSON.stringify(input) : "";
}

export function validateProviderConversion(
	input: unknown,
	options: ProviderImportOptions = {},
): ProviderConversionResult {
	const checkpoint = providerCheckpoint(options);
	checkpoint();
	boundedDocumentJson(input, checkpoint, false);
	const parsed = resultSchema.safeParse(input);
	if (!parsed.success) throw new ProviderImportError("invalid-result");
	let document: PortableExportV1;
	try {
		document = parsePortableExportV1(
			boundedDocumentJson(parsed.data.document, checkpoint),
		);
	} catch (error) {
		if (error instanceof ProviderImportError) throw error;
		if (
			error instanceof PortableExportValidationError &&
			(error.code === "byte-limit" || error.code === "row-limit")
		)
			throw new ProviderImportError(error.code);
		throw new ProviderImportError("invalid-result");
	}
	checkpoint();
	if (
		parsed.data.sourceNamespace !== parsed.data.sourceNamespace.toLowerCase() ||
		document.sourceUserId !==
			(parsed.data.adapter === CSV_ADAPTER
				? csvSourceUserId(parsed.data.sourceNamespace)
				: parsed.data.adapter === TRELLO_ADAPTER
					? trelloSourceUserId(parsed.data.sourceNamespace)
					: todoistSourceUserId(parsed.data.sourceNamespace))
	)
		throw new ProviderImportError("invalid-result");
	const { data } = document;
	const owner = document.sourceUserId;
	const namespace = parsed.data.sourceNamespace;
	const todoist = parsed.data.adapter === TODOIST_ADAPTER;
	const trello = parsed.data.adapter === TRELLO_ADAPTER;
	const prefix = `${todoist ? "todoist" : trello ? "trello" : "csv"}:1:${namespace}`;
	const workspace = `${prefix}:workspace`;
	const project = `${prefix}:folder:${trello ? "board" : "project"}`;
	const trelloId = "[0-9a-f]{24}";
	if (parsed.data.adapter === TRELLO_ADAPTER) {
		if (snapshotNamespace(parsed.data.boardIdSha256) !== namespace)
			throw new ProviderImportError("invalid-result");
		const folder = data.folders[0];
		if (
			!folder ||
			data.folders.length !== 1 ||
			folder.id !== project ||
			folder.workspaceId !== workspace
		)
			throw new ProviderImportError("unsupported-content");
		checkProviderText(folder.name, 500);
		if (!folder.name.trim()) throw new ProviderImportError("invalid-result");
	}
	if (parsed.data.adapter === TODOIST_ADAPTER) {
		if (snapshotNamespace(parsed.data.snapshotSha256) !== namespace)
			throw new ProviderImportError("invalid-result");
		for (const name of [
			parsed.data.projectFolderName,
			parsed.data.unsectionedListName,
		]) {
			checkProviderText(name, 500);
			if (!name.trim()) throw new ProviderImportError("invalid-result");
		}
		if (
			data.lists[0]?.id !== `${prefix}:list:unsectioned` ||
			data.folders.length !== 1 ||
			data.folders[0]?.id !== project ||
			data.folders[0]?.workspaceId !== workspace ||
			data.folders[0]?.name !== parsed.data.projectFolderName
		)
			throw new ProviderImportError("unsupported-content");
	}
	if (
		data.principals.length !== 1 ||
		data.principals[0]?.id !== owner ||
		data.principals[0]?.name !== "Untrusted migration owner" ||
		data.workspaces.length !== 1 ||
		data.workspaces[0]?.id !== workspace ||
		data.workspaces[0]?.ownerId !== owner ||
		data.workspaces[0]?.kind !== "personal" ||
		data.memberships.length !== 1 ||
		data.memberships[0]?.id !== `${prefix}:membership` ||
		data.memberships[0]?.workspaceId !== workspace ||
		data.memberships[0]?.userId !== owner ||
		data.memberships[0]?.role !== "owner"
	)
		throw new ProviderImportError("invalid-result");
	const allowed = new Set([
		"principals",
		"workspaces",
		"memberships",
		"lists",
		"tasks",
	]);
	if (todoist || trello) allowed.add("folders");
	if (
		Object.entries(data).some(([key, rows]) => !allowed.has(key) && rows.length)
	)
		throw new ProviderImportError("unsupported-content");
	for (const list of data.lists) {
		checkpoint();
		if (
			list.workspaceId !== workspace ||
			list.ownerId !== owner ||
			!list.id.startsWith(`${prefix}:list:`) ||
			list.kind !== "tasks" ||
			list.icon !== null ||
			list.folderId !== (todoist || trello ? project : null) ||
			list.completedDisplay !== "sink"
		)
			throw new ProviderImportError("unsupported-content");
		if (trello && !new RegExp(`^${prefix}:list:${trelloId}$`).test(list.id))
			throw new ProviderImportError("unsupported-content");
		if (
			todoist &&
			list.id !== `${prefix}:list:unsectioned` &&
			!new RegExp(`^${prefix}:list:record:[1-9][0-9]*$`).test(list.id)
		)
			throw new ProviderImportError("unsupported-content");
		if (
			parsed.data.adapter === TODOIST_ADAPTER &&
			list.id === `${prefix}:list:unsectioned` &&
			list.title !== parsed.data.unsectionedListName
		)
			throw new ProviderImportError("unsupported-content");
		checkProviderText(list.title, 500);
	}
	for (const task of data.tasks) {
		checkpoint();
		if (
			!task.id.startsWith(`${prefix}:task:`) ||
			task.priority < 0 ||
			task.priority > 3 ||
			task.rrule !== null ||
			task.recurrenceRelative ||
			task.createdAt != null ||
			task.recurrenceAnchorAt != null ||
			task.recurrenceConsumed != null ||
			task.quantity !== null ||
			task.unit !== null ||
			task.category !== null ||
			task.reminderTime !== null ||
			task.repeatEveryMin !== null ||
			task.maxRepeats !== null ||
			task.fallbackUserId !== null ||
			task.urgent
		)
			throw new ProviderImportError("unsupported-content");
		if (
			todoist &&
			(!new RegExp(`^${prefix}:task:record:[1-9][0-9]*$`).test(task.id) ||
				task.done ||
				task.completedAt !== null ||
				task.dueAt !== null ||
				task.dueAllDay)
		)
			throw new ProviderImportError("unsupported-content");
		if (
			trello &&
			(!new RegExp(`^${prefix}:task:${trelloId}$`).test(task.id) ||
				task.parentId !== null ||
				task.priority !== 0 ||
				task.done ||
				task.completedAt !== null ||
				task.dueAt !== null ||
				task.dueAllDay)
		)
			throw new ProviderImportError("unsupported-content");
		checkProviderText(task.title, 500);
		if (task.notes !== null)
			checkProviderText(task.notes, PROVIDER_MAX_FIELD_BYTES - 1);
	}
	if (!validateImportGraph(document, checkpoint).valid)
		throw new ProviderImportError("invalid-graph");
	checkpoint();
	return { ...parsed.data, document };
}
