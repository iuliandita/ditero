import { z } from "zod";
import { ProviderImportError, snapshotNamespace } from "./common.ts";
import {
	CONTENT_ADAPTER,
	CONTENT_PROVIDERS,
	type ContentConversion,
	NOTICE_CODES,
} from "./content-common.ts";

const name = z
	.string()
	.min(1)
	.refine(
		(value) =>
			value.trim() &&
			!value.includes("\u0000") &&
			value.isWellFormed() &&
			new TextEncoder().encode(value).byteLength <= 500,
	);
const shape = {
	kind: z.literal("provider"),
	version: z.literal(2),
	adapter: z.literal(CONTENT_ADAPTER),
	adapterVersion: z.literal(1),
	provider: z.enum(CONTENT_PROVIDERS),
	sourceNamespace: z.uuid().refine((value) => value === value.toLowerCase()),
	identityMode: z.literal("snapshot-rows"),
	snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
	projectFolderName: name,
	unsectionedListName: name,
	timezone: name,
	dateOrder: z.enum(["mdy", "dmy"]).nullable(),
	anchorDay: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.nullable(),
	notices: z
		.array(
			z.strictObject({
				code: z.enum(NOTICE_CODES),
				path: z
					.string()
					.refine(
						(value) =>
							!value.includes("\u0000") &&
							value.isWellFormed() &&
							new TextEncoder().encode(value).byteLength <= 512,
					),
				count: z.number().int().min(1).max(50_000),
			}),
		)
		.max(512),
};
const sameNamespace = (value: {
	sourceNamespace: string;
	snapshotSha256: string;
}) =>
	/^[a-f0-9]{64}$/.test(value.snapshotSha256) &&
	snapshotNamespace(value.snapshotSha256) === value.sourceNamespace;
const boundedNotices = (value: { notices: unknown[] }) =>
	new TextEncoder().encode(JSON.stringify(value.notices)).byteLength <= 300_000;
const bindingSchema = z
	.strictObject(shape)
	.refine(sameNamespace)
	.refine(boundedNotices);
const inputSchema = z
	.strictObject({
		...shape,
		originalBase64: z
			.string()
			.min(1)
			.max(4 * Math.ceil((23 * 1024 * 1024) / 3)),
	})
	.refine(sameNamespace)
	.refine(boundedNotices);
export type ContentInputBinding = z.infer<typeof bindingSchema>;
export type ContentImportInput = z.infer<typeof inputSchema>;

function ownData(value: unknown, keys: string[]): Record<string, unknown> {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new ProviderImportError("invalid-metadata");
	const actual = Reflect.ownKeys(value);
	if (
		actual.length !== keys.length ||
		actual.some((key) => typeof key !== "string" || !keys.includes(key))
	)
		throw new ProviderImportError("invalid-metadata");
	return Object.fromEntries(
		keys.map((key) => {
			const property = Object.getOwnPropertyDescriptor(value, key);
			if (!property || !("value" in property) || !property.enumerable)
				throw new ProviderImportError("invalid-metadata");
			return [key, property.value];
		}),
	);
}
function safeRaw(value: unknown, input: boolean) {
	const raw = ownData(value, [
		...Object.keys(shape),
		...(input ? ["originalBase64"] : []),
	]);
	if (
		!Array.isArray(raw.notices) ||
		raw.notices.length > 512 ||
		Object.getPrototypeOf(raw.notices) !== Array.prototype ||
		Reflect.ownKeys(raw.notices).length !== raw.notices.length + 1
	)
		throw new ProviderImportError("invalid-metadata");
	const notices: Record<string, unknown>[] = [];
	for (let index = 0; index < raw.notices.length; index++) {
		const item = Object.getOwnPropertyDescriptor(raw.notices, String(index));
		if (!item || !("value" in item))
			throw new ProviderImportError("invalid-metadata");
		notices.push(ownData(item.value, ["code", "path", "count"]));
	}
	raw.notices = notices;
	return raw;
}
export function parseContentBinding(value: unknown): ContentInputBinding {
	const parsed = bindingSchema.safeParse(safeRaw(value, false));
	if (!parsed.success) throw new ProviderImportError("invalid-metadata");
	return parsed.data;
}
export function parseContentInput(value: unknown): ContentImportInput {
	const parsed = inputSchema.safeParse(safeRaw(value, true));
	if (!parsed.success) throw new ProviderImportError("invalid-metadata");
	return parsed.data;
}
export function contentBinding(
	conversion: ContentConversion,
): ContentInputBinding {
	const { document: _document, ...metadata } = conversion;
	return parseContentBinding({ kind: "provider", version: 2, ...metadata });
}
