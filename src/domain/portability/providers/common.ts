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

export type ProviderImportCode =
	| "byte-limit"
	| "row-limit"
	| "field-limit"
	| "invalid-encoding"
	| "invalid-csv"
	| "invalid-metadata"
	| "invalid-row"
	| "invalid-date"
	| "invalid-graph"
	| "invalid-result"
	| "unsupported-content"
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

export interface ProviderConversionResult {
	adapter: typeof CSV_ADAPTER;
	adapterVersion: typeof CSV_ADAPTER_VERSION;
	sourceNamespace: string;
	identityMode: "stable-ids";
	document: PortableExportV1;
	findings: { code: "untrusted-migration-owner"; path: "sourceUserId" }[];
}

const resultSchema = z.strictObject({
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

function boundedDocumentJson(input: unknown, checkpoint: () => void): string {
	const pending: { iterator: Iterator<unknown>; depth: number }[] = [
		{ iterator: [input][Symbol.iterator](), depth: 0 },
	];
	let bytes = 0;
	let visited = 0;
	const add = (count: number) => {
		bytes += count;
		if (bytes > PROVIDER_MAX_BYTES) throw new ProviderImportError("byte-limit");
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
			add(2 + Math.max(0, value.length - 1));
			pending.push({ iterator: value.values(), depth: frame.depth + 1 });
		} else if (
			value &&
			typeof value === "object" &&
			(Object.getPrototypeOf(value) === Object.prototype ||
				Object.getPrototypeOf(value) === null)
		) {
			const keys = Object.keys(value);
			if (keys.length > 64) throw new ProviderImportError("invalid-result");
			add(2 + Math.max(0, keys.length - 1));
			function* children() {
				for (const key of keys) {
					checkProviderText(key, 512);
					const property = Object.getOwnPropertyDescriptor(value, key);
					if (!property || !("value" in property))
						throw new ProviderImportError("invalid-result");
					add(new TextEncoder().encode(JSON.stringify(key)).byteLength + 1);
					yield property.value;
				}
			}
			pending.push({ iterator: children(), depth: frame.depth + 1 });
		} else throw new ProviderImportError("invalid-result");
	}
	return JSON.stringify(input);
}

export function validateProviderConversion(
	input: unknown,
	options: ProviderImportOptions = {},
): ProviderConversionResult {
	const checkpoint = providerCheckpoint(options);
	checkpoint();
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
		document.sourceUserId !== csvSourceUserId(parsed.data.sourceNamespace)
	)
		throw new ProviderImportError("invalid-result");
	const { data } = document;
	const owner = document.sourceUserId;
	const namespace = parsed.data.sourceNamespace;
	const workspace = `csv:1:${namespace}:workspace`;
	if (
		data.principals.length !== 1 ||
		data.principals[0]?.id !== owner ||
		data.principals[0]?.name !== "Untrusted migration owner" ||
		data.workspaces.length !== 1 ||
		data.workspaces[0]?.id !== workspace ||
		data.workspaces[0]?.ownerId !== owner ||
		data.workspaces[0]?.kind !== "personal" ||
		data.memberships.length !== 1 ||
		data.memberships[0]?.id !== `csv:1:${namespace}:membership` ||
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
	if (
		Object.entries(data).some(([key, rows]) => !allowed.has(key) && rows.length)
	)
		throw new ProviderImportError("unsupported-content");
	for (const list of data.lists) {
		checkpoint();
		if (
			list.workspaceId !== workspace ||
			list.ownerId !== owner ||
			!list.id.startsWith(`csv:1:${namespace}:list:`) ||
			list.kind !== "tasks" ||
			list.icon !== null ||
			list.folderId !== null ||
			list.completedDisplay !== "sink"
		)
			throw new ProviderImportError("unsupported-content");
		checkProviderText(list.title, 500);
	}
	for (const task of data.tasks) {
		checkpoint();
		if (
			!task.id.startsWith(`csv:1:${namespace}:task:`) ||
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
		checkProviderText(task.title, 500);
		if (task.notes !== null)
			checkProviderText(task.notes, PROVIDER_MAX_FIELD_BYTES - 1);
	}
	if (!validateImportGraph(document, checkpoint).valid)
		throw new ProviderImportError("invalid-graph");
	checkpoint();
	return { ...parsed.data, document };
}
