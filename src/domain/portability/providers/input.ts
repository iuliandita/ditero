import { z } from "zod";
import { hashImportValue } from "../import-digest.ts";
import {
	CSV_ADAPTER,
	CSV_ADAPTER_VERSION,
	type ProviderImportOptions,
	providerCheckpoint,
	snapshotNamespace,
	TODOIST_ADAPTER,
	TODOIST_V1_EXCLUSIONS,
} from "./common.ts";
import { parseTaskCsv } from "./csv.ts";
import { parseTodoistProjectCsv } from "./todoist.ts";

export { TODOIST_V1_EXCLUSIONS } from "./common.ts";

export const PROVIDER_INPUT_MAX_BYTES = 23 * 1024 * 1024;
export const PROVIDER_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
export const CSV_V1_EXCLUSIONS = Object.freeze([
	"assignments",
	"labels",
	"comments",
	"templates",
	"history",
	"attachments",
	"recurrence",
	"reminders",
	"personal-state",
	"folders",
	"list-customization",
	"shopping-fields",
	"task-creation-times",
	"urgency",
] as const);

type InputCode =
	| "invalid-input"
	| "invalid-binding"
	| "invalid-base64"
	| "byte-limit"
	| "metadata-mismatch"
	| "invalid-digest";
export class ProviderInputError extends Error {
	constructor(readonly code: InputCode) {
		super(code);
		this.name = "ProviderInputError";
	}
}

const bindingShape = {
	kind: z.literal("provider"),
	version: z.literal(1),
	adapter: z.literal(CSV_ADAPTER),
	adapterVersion: z.literal(CSV_ADAPTER_VERSION),
	sourceNamespace: z.uuid().refine((value) => value === value.toLowerCase()),
	identityMode: z.literal("stable-ids"),
	exclusions: z
		.array(z.string())
		.length(CSV_V1_EXCLUSIONS.length)
		.refine((values) =>
			values.every((value, index) => value === CSV_V1_EXCLUSIONS[index]),
		),
};
const csvBindingSchema = z.strictObject(bindingShape);
const csvInputSchema = z.strictObject({
	...bindingShape,
	originalCsvBase64: z.string(),
});
const boundedName = z
	.string()
	.min(1)
	.refine(
		(value) =>
			value.trim().length > 0 &&
			!value.includes("\u0000") &&
			value.isWellFormed() &&
			new TextEncoder().encode(value).byteLength <= 500,
	);
const todoistBindingShape = {
	kind: z.literal("provider"),
	version: z.literal(1),
	adapter: z.literal(TODOIST_ADAPTER),
	adapterVersion: z.literal(1),
	sourceNamespace: bindingShape.sourceNamespace,
	identityMode: z.literal("snapshot-rows"),
	snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
	projectFolderName: boundedName,
	unsectionedListName: boundedName,
	exclusions: z
		.array(z.string())
		.length(TODOIST_V1_EXCLUSIONS.length)
		.refine((values) =>
			values.every((value, index) => value === TODOIST_V1_EXCLUSIONS[index]),
		),
};
const todoistBindingSchema = z
	.strictObject(todoistBindingShape)
	.refine(
		(value) =>
			snapshotNamespace(value.snapshotSha256) === value.sourceNamespace,
	);
const todoistInputSchema = z
	.strictObject({ ...todoistBindingShape, originalCsvBase64: z.string() })
	.refine(
		(value) =>
			snapshotNamespace(value.snapshotSha256) === value.sourceNamespace,
	);
export type CsvProviderImportInput = z.infer<typeof csvInputSchema>;
export type ProviderInputBinding =
	| z.infer<typeof csvBindingSchema>
	| z.infer<typeof todoistBindingSchema>;
export type ProviderImportInput =
	| CsvProviderImportInput
	| z.infer<typeof todoistInputSchema>;
const bindingKeys = Object.keys(bindingShape);

function rawObject(
	value: unknown,
	keys: string[],
	code: InputCode,
	policy: readonly string[] = CSV_V1_EXCLUSIONS,
): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		(Object.getPrototypeOf(value) !== Object.prototype &&
			Object.getPrototypeOf(value) !== null)
	)
		throw new ProviderInputError(code);
	const actualKeys = Reflect.ownKeys(value);
	if (
		actualKeys.length !== keys.length ||
		actualKeys.some((key) => typeof key !== "string" || !keys.includes(key))
	)
		throw new ProviderInputError(code);
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const property = Object.getOwnPropertyDescriptor(value, key);
		if (!property || !("value" in property) || !property.enumerable)
			throw new ProviderInputError(code);
		result[key] = property.value;
	}
	const exclusions = result.exclusions;
	if (
		!Array.isArray(exclusions) ||
		Object.getPrototypeOf(exclusions) !== Array.prototype ||
		exclusions.length !== policy.length ||
		Reflect.ownKeys(exclusions).length !== exclusions.length + 1
	)
		throw new ProviderInputError(code);
	const safePolicy: string[] = [];
	for (let index = 0; index < policy.length; index++) {
		const property = Object.getOwnPropertyDescriptor(exclusions, String(index));
		if (!property || !("value" in property) || property.value !== policy[index])
			throw new ProviderInputError(code);
		safePolicy.push(property.value);
	}
	result.exclusions = safePolicy;
	return result;
}

export function parseProviderBinding(
	value: unknown,
	options: ProviderImportOptions = {},
): ProviderInputBinding {
	const checkpoint = providerCheckpoint(options);
	checkpoint();
	const todoist =
		typeof value === "object" &&
		value !== null &&
		Object.getOwnPropertyDescriptor(value, "adapter")?.value ===
			TODOIST_ADAPTER;
	const parsed = todoist
		? todoistBindingSchema.safeParse(
				rawObject(
					value,
					Object.keys(todoistBindingShape),
					"invalid-binding",
					TODOIST_V1_EXCLUSIONS,
				),
			)
		: csvBindingSchema.safeParse(
				rawObject(value, bindingKeys, "invalid-binding"),
			);
	if (!parsed.success) throw new ProviderInputError("invalid-binding");
	checkpoint();
	return parsed.data;
}

function base64ByteLength(value: string): number {
	if (value.length > 4 * Math.ceil(PROVIDER_INPUT_MAX_BYTES / 3))
		throw new ProviderInputError("byte-limit");
	if (
		!value.length ||
		value.length % 4 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	)
		throw new ProviderInputError("invalid-base64");
	const bytes =
		(value.length / 4) * 3 -
		(value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
	if (bytes > PROVIDER_INPUT_MAX_BYTES)
		throw new ProviderInputError("byte-limit");
	return bytes;
}

function decodeBase64(value: string, checkpoint: () => void): Uint8Array {
	const bytes = new Uint8Array(base64ByteLength(value));
	let offset = 0;
	for (let start = 0; start < value.length; start += 65_536) {
		checkpoint();
		const chunk = value.slice(start, start + 65_536);
		let binary: string;
		try {
			binary = atob(chunk);
		} catch {
			throw new ProviderInputError("invalid-base64");
		}
		if (btoa(binary) !== chunk) throw new ProviderInputError("invalid-base64");
		for (let index = 0; index < binary.length; index++)
			bytes[offset++] = binary.charCodeAt(index);
	}
	checkpoint();
	return bytes;
}

export function parseProviderInput(
	value: unknown,
	options: ProviderImportOptions = {},
): ProviderImportInput {
	const checkpoint = providerCheckpoint(options);
	checkpoint();
	const todoist =
		typeof value === "object" &&
		value !== null &&
		Object.getOwnPropertyDescriptor(value, "adapter")?.value ===
			TODOIST_ADAPTER;
	const raw = rawObject(
		value,
		[
			...(todoist ? Object.keys(todoistBindingShape) : bindingKeys),
			"originalCsvBase64",
		],
		"invalid-input",
		todoist ? TODOIST_V1_EXCLUSIONS : CSV_V1_EXCLUSIONS,
	);
	if (typeof raw.originalCsvBase64 !== "string")
		throw new ProviderInputError("invalid-input");
	base64ByteLength(raw.originalCsvBase64);
	const parsed = todoist
		? todoistInputSchema.safeParse(raw)
		: csvInputSchema.safeParse(raw);
	if (!parsed.success) throw new ProviderInputError("invalid-input");
	// Source and mappings must also fit this request bound at the HTTP boundary.
	if (
		new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength >
		PROVIDER_REQUEST_MAX_BYTES
	)
		throw new ProviderInputError("byte-limit");
	// Check unused padding bits without allocating the whole decoded file.
	decodeBase64(parsed.data.originalCsvBase64.slice(-4), checkpoint);
	checkpoint();
	return parsed.data;
}

export function prepareProviderImport(
	value: unknown,
	options: ProviderImportOptions & { exportedAt: string },
) {
	const boundedOptions = {
		...options,
		deadline: Math.min(
			options.deadline ?? Number.POSITIVE_INFINITY,
			performance.now() + 15_000,
		),
	};
	const checkpoint = providerCheckpoint(boundedOptions);
	const input = parseProviderInput(value, boundedOptions);
	if (input.adapter !== CSV_ADAPTER)
		throw new ProviderInputError("invalid-input");
	const bytes = decodeBase64(input.originalCsvBase64, checkpoint);
	const conversion = parseTaskCsv(bytes, boundedOptions);
	if (
		conversion.sourceNamespace !== input.sourceNamespace ||
		conversion.adapter !== input.adapter ||
		conversion.adapterVersion !== input.adapterVersion ||
		conversion.identityMode !== input.identityMode
	)
		throw new ProviderInputError("metadata-mismatch");
	const { originalCsvBase64: _originalCsvBase64, ...metadata } = input;
	const binding = parseProviderBinding(metadata, boundedOptions);
	checkpoint();
	return {
		binding,
		conversion,
		sourceFormat: CSV_ADAPTER,
		sourceSchemaVersion: 1 as const,
		originalBytes: bytes.byteLength,
	};
}

export async function prepareProviderImportRequest(
	value: unknown,
	options: ProviderImportOptions & { exportedAt: string },
) {
	const boundedOptions = {
		...options,
		deadline: Math.min(
			options.deadline ?? Infinity,
			performance.now() + 15_000,
		),
	};
	const checkpoint = providerCheckpoint(boundedOptions);
	const input = parseProviderInput(value, boundedOptions);
	if (input.adapter === CSV_ADAPTER)
		return prepareProviderImport(input, boundedOptions);
	const bytes = decodeBase64(input.originalCsvBase64, checkpoint);
	const conversion = await parseTodoistProjectCsv(bytes, {
		...boundedOptions,
		projectFolderName: input.projectFolderName,
		unsectionedListName: input.unsectionedListName,
	});
	if (
		conversion.snapshotSha256 !== input.snapshotSha256 ||
		conversion.sourceNamespace !== input.sourceNamespace
	)
		throw new ProviderInputError("metadata-mismatch");
	const { originalCsvBase64: _originalCsvBase64, ...metadata } = input;
	const binding = parseProviderBinding(metadata, boundedOptions);
	checkpoint();
	return {
		binding,
		conversion,
		sourceFormat: TODOIST_ADAPTER,
		sourceSchemaVersion: 1 as const,
		originalBytes: bytes.byteLength,
	};
}

export async function providerDocumentDigest(
	binding: unknown,
	ordinaryDocumentDigest: string,
	options: ProviderImportOptions = {},
): Promise<string> {
	const checkpoint = providerCheckpoint(options);
	const metadata = parseProviderBinding(binding, options);
	if (!/^[0-9a-f]{64}$/.test(ordinaryDocumentDigest))
		throw new ProviderInputError("invalid-digest");
	return hashImportValue(
		"ditero-import-provider-document-v1",
		{ binding: metadata, ordinaryDocumentDigest },
		checkpoint,
	);
}
