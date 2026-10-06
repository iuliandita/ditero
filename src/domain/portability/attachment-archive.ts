import { z } from "zod";
import { aadId, joinAad, TAG_BYTES } from "../e2e/envelope.ts";
import { decodeWrapped, MAX_WRAPPED_LENGTH } from "../e2e/wire.ts";
import type { PortableExportV1, PortableRows } from "./v1.ts";
import type { PortableExportV2 } from "./v2.ts";
import { parseBoundedPortableJson, portableTimestamp } from "./validate.ts";

export const ATTACHMENT_ARCHIVE_LIMITS = {
	serializedBytes: 32 * 1024 * 1024,
	ciphertextBytes: 16 * 1024 * 1024,
	entries: 64,
	manifestBytes: 32 * 1024,
} as const;

export class AttachmentArchiveContractError extends Error {
	constructor(
		readonly code: "byte-limit" | "invalid-contract" | "binding-mismatch",
	) {
		super(`attachment archive: ${code}`);
		this.name = "AttachmentArchiveContractError";
	}
}
const fail = (code: AttachmentArchiveContractError["code"]): never => {
	throw new AttachmentArchiveContractError(code);
};

const alphabet =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function base64Bytes(value: string): number | null {
	if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
	const remainder = value.length % 4;
	const last = alphabet.indexOf(value.at(-1) ?? "");
	if (
		(remainder === 2 && (last & 15) !== 0) ||
		(remainder === 3 && (last & 3) !== 0)
	)
		return null;
	return Math.floor((value.length * 3) / 4);
}
const encoded = (maxBytes: number, exact = false) =>
	z
		.string()
		.max(Math.ceil((maxBytes * 4) / 3))
		.refine((value) => {
			const length = base64Bytes(value);
			return (
				length !== null && (exact ? length === maxBytes : length <= maxBytes)
			);
		}, "Expected bounded canonical base64url");
const wrapped = (plaintextBytes?: number, exact = false) =>
	z
		.string()
		.min(1)
		.max(MAX_WRAPPED_LENGTH)
		.refine((value) => {
			if (base64Bytes(value) === null) return false;
			try {
				const record = decodeWrapped(value);
				const length = record.ciphertext.length - TAG_BYTES;
				return (
					plaintextBytes === undefined ||
					(exact ? length === plaintextBytes : length <= plaintextBytes)
				);
			} catch {
				return false;
			}
		}, "Expected a supported bounded wrapped record");
const id = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_-]+$/);
const uuid = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const byteCount = z
	.number()
	.int()
	.positive()
	.max(ATTACHMENT_ARCHIVE_LIMITS.ciphertextBytes);
const objectSchema = z.strictObject({
	entryId: uuid,
	content: encoded(ATTACHMENT_ARCHIVE_LIMITS.ciphertextBytes),
	thumbnail: encoded(ATTACHMENT_ARCHIVE_LIMITS.ciphertextBytes).nullable(),
});
const archiveSchema = z.strictObject({
	format: z.literal("ditero-attachment-archive"),
	schemaVersion: z.literal(1),
	archiveId: uuid,
	unlock: z.strictObject({ kdfVersion: z.literal(1), salt: encoded(16, true) }),
	protectedManifest: wrapped(ATTACHMENT_ARCHIVE_LIMITS.manifestBytes),
	objects: z.array(objectSchema).min(1).max(ATTACHMENT_ARCHIVE_LIMITS.entries),
});
const payloadSchema = z.strictObject({ bytes: byteCount, sha256 });
const entrySchema = z.strictObject({
	entryId: uuid,
	source: z.strictObject({
		id,
		workspaceId: id,
		keyVersion: z.number().int().positive().max(2_147_483_647),
		parentKind: z.enum(["task", "comment", "list"]),
		parentId: id,
		filenameCiphertext: wrapped(),
		contentTypeCiphertext: wrapped(),
		dekWrapped: wrapped(32, true),
	}),
	locallyExportedDek: encoded(32, true),
	content: payloadSchema,
	thumbnail: payloadSchema.nullable(),
});
const manifestSchema = z
	.strictObject({
		archiveId: uuid,
		exportedAt: portableTimestamp,
		contentDocument: z.strictObject({
			format: z.literal("ditero"),
			schemaVersion: z.union([z.literal(1), z.literal(2)]),
			exactBytesSha256: sha256,
			sourceUserId: id,
			sourceNamespace: uuid.nullable(),
		}),
		entries: z.array(entrySchema).min(1).max(ATTACHMENT_ARCHIVE_LIMITS.entries),
	})
	.refine(
		({ contentDocument }) =>
			(contentDocument.schemaVersion === 1) ===
			(contentDocument.sourceNamespace === null),
		"Source namespace must match the content version",
	);

type Immutable<T> = T extends (infer Item)[]
	? readonly Immutable<Item>[]
	: T extends object
		? { readonly [Key in keyof T]: Immutable<T[Key]> }
		: T;
export type AttachmentArchiveContract = Immutable<
	z.infer<typeof archiveSchema>
>;
export type AttachmentArchiveManifestContract = Immutable<
	z.infer<typeof manifestSchema>
>;

function freeze<T>(value: T): Immutable<T> {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value as Immutable<T>;
}
function json(input: string, maxBytes: number): unknown {
	let length = 0;
	for (const character of input) {
		const point = character.codePointAt(0) ?? 0;
		length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
		if (length > maxBytes) fail("byte-limit");
	}
	let value: unknown;
	try {
		value = parseBoundedPortableJson(input);
	} catch {
		return fail("invalid-contract");
	}
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	let visited = 0;
	while (pending.length) {
		const next = pending.pop();
		if (!next) return fail("invalid-contract");
		if (++visited > 4096 || next.depth > 8) fail("invalid-contract");
		if (next.value !== null && typeof next.value === "object") {
			if (
				Array.isArray(next.value) &&
				next.value.length > ATTACHMENT_ARCHIVE_LIMITS.entries
			)
				fail("invalid-contract");
			for (const [key, child] of Object.entries(next.value)) {
				if (["__proto__", "prototype", "constructor"].includes(key))
					fail("invalid-contract");
				pending.push({ value: child, depth: next.depth + 1 });
			}
		}
	}
	return value;
}
function unique(values: readonly string[]): void {
	if (new Set(values).size !== values.length) fail("invalid-contract");
}
function aggregate(values: readonly number[]): void {
	let total = 0;
	for (const value of values) {
		total += value;
		if (
			!Number.isSafeInteger(total) ||
			total > ATTACHMENT_ARCHIVE_LIMITS.ciphertextBytes
		)
			fail("byte-limit");
	}
}

// Shape and length admission only. No hash, AEAD, file digest or authority is verified here.
export function parseAttachmentArchiveContract(
	input: string,
): AttachmentArchiveContract {
	const result = archiveSchema.safeParse(
		json(input, ATTACHMENT_ARCHIVE_LIMITS.serializedBytes),
	);
	if (!result.success) return fail("invalid-contract");
	unique(result.data.objects.map((object) => object.entryId));
	aggregate(
		result.data.objects.flatMap((object) => [
			base64Bytes(object.content) ?? 0,
			object.thumbnail === null ? 0 : (base64Bytes(object.thumbnail) ?? 0),
		]),
	);
	return freeze(result.data);
}

// Call on the locally opened manifest, or before KDF/encryption during export selection.
export function parseAttachmentArchiveManifestContract(
	input: string,
): AttachmentArchiveManifestContract {
	const result = manifestSchema.safeParse(
		json(input, ATTACHMENT_ARCHIVE_LIMITS.manifestBytes),
	);
	if (!result.success) return fail("invalid-contract");
	unique(result.data.entries.map((entry) => entry.entryId));
	unique(result.data.entries.map((entry) => entry.source.id));
	aggregate(
		result.data.entries.flatMap((entry) => [
			entry.content.bytes,
			entry.thumbnail?.bytes ?? 0,
		]),
	);
	return freeze(result.data);
}

export function attachmentArchiveAad(
	unlock: Pick<AttachmentArchiveContract, "archiveId" | "unlock">,
): Uint8Array {
	if (
		!uuid.safeParse(unlock.archiveId).success ||
		!archiveSchema.shape.unlock.safeParse(unlock.unlock).success
	)
		return fail("invalid-contract");
	return joinAad([
		"ditero:attachment-archive:v1",
		aadId("archiveId", unlock.archiveId),
		String(unlock.unlock.kdfVersion),
		unlock.unlock.salt,
	]);
}

export function assertAttachmentArchiveObjectBinding(
	archive: AttachmentArchiveContract,
	manifest: AttachmentArchiveManifestContract,
): void {
	if (
		archive.archiveId !== manifest.archiveId ||
		archive.objects.length !== manifest.entries.length
	)
		fail("binding-mismatch");
	const objects = new Map(
		archive.objects.map((object) => [object.entryId, object]),
	);
	for (const entry of manifest.entries) {
		const object = objects.get(entry.entryId);
		if (
			!object ||
			base64Bytes(object.content) !== entry.content.bytes ||
			(object.thumbnail === null) !== (entry.thumbnail === null) ||
			(object.thumbnail !== null &&
				base64Bytes(object.thumbnail) !== entry.thumbnail?.bytes)
		)
			fail("binding-mismatch");
	}
}

export function assertAttachmentArchivePortableRowBinding(
	manifest: AttachmentArchiveManifestContract,
	document: PortableExportV1 | PortableExportV2,
): void {
	const binding = manifest.contentDocument;
	if (
		document.format !== binding.format ||
		document.schemaVersion !== binding.schemaVersion ||
		document.sourceUserId !== binding.sourceUserId ||
		(document.schemaVersion === 2 ? document.sourceNamespace : null) !==
			binding.sourceNamespace
	)
		fail("binding-mismatch");
	const rows = new Map<string, PortableRows["attachments"]>();
	for (const row of document.data.attachments) {
		if (rows.has(row.id)) fail("binding-mismatch");
		rows.set(row.id, row);
	}
	for (const entry of manifest.entries) {
		const row = rows.get(entry.source.id);
		if (
			!row ||
			row.committedAt === null ||
			row.id !== entry.source.id ||
			row.workspaceId !== entry.source.workspaceId ||
			row.parentKind !== entry.source.parentKind ||
			row.parentId !== entry.source.parentId ||
			row.keyVersion !== entry.source.keyVersion ||
			row.declaredBytes !== entry.content.bytes ||
			row.observedBytes !== entry.content.bytes ||
			row.ciphertextSha256 !== entry.content.sha256 ||
			row.thumbnailDeclaredBytes !== (entry.thumbnail?.bytes ?? null) ||
			row.thumbnailObservedBytes !== (entry.thumbnail?.bytes ?? null) ||
			row.thumbnailCiphertextSha256 !== (entry.thumbnail?.sha256 ?? null)
		)
			fail("binding-mismatch");
	}
}
