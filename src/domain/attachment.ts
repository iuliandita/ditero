export const PREVIEWABLE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
] as const;

const PREVIEWABLE_TYPE_SET = new Set<string>(PREVIEWABLE_TYPES);
const MAX_FILENAME_LENGTH = 255;
const MAX_STORAGE_SEGMENT_LENGTH = 255;
const THUMBNAIL_SUFFIX = ".thumbnail";
const CONTROL_OR_BIDI = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;
const STORAGE_ID = /^[A-Za-z0-9_-]+$/;

function sliceWithoutDanglingSurrogate(value: string, length: number): string {
	let result = value.slice(0, length);
	const last = result.charCodeAt(result.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) result = result.slice(0, -1);
	return result;
}

export function sanitiseFilename(value: string): string {
	const basename = (value.split(/[\\/]/).at(-1) ?? "").replace(
		CONTROL_OR_BIDI,
		"",
	);
	if (basename === "" || basename === "." || basename === "..") return "file";
	if (basename.length <= MAX_FILENAME_LENGTH) return basename;

	const dot = basename.lastIndexOf(".");
	const extension = dot > 0 ? basename.slice(dot) : "";
	if (extension.length >= MAX_FILENAME_LENGTH) {
		return sliceWithoutDanglingSurrogate(basename, MAX_FILENAME_LENGTH);
	}
	const stem = extension === "" ? basename : basename.slice(0, dot);
	return `${sliceWithoutDanglingSurrogate(
		stem,
		MAX_FILENAME_LENGTH - extension.length,
	)}${extension}`;
}

export function isPreviewable(contentType: string): boolean {
	return PREVIEWABLE_TYPE_SET.has(contentType);
}

export type QuotaUsage = {
	committed: number;
	reserved: number;
	incoming: number;
	limit: number;
};

export function quotaWouldExceed(usage: QuotaUsage): boolean {
	for (const [field, value] of Object.entries(usage)) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(
				`attachment quota: ${field} must be a non-negative safe integer`,
			);
		}
	}
	return (
		BigInt(usage.committed) + BigInt(usage.reserved) + BigInt(usage.incoming) >
		BigInt(usage.limit)
	);
}

function storageId(field: string, value: string, maxLength: number): string {
	if (
		value.length === 0 ||
		value.length > maxLength ||
		!STORAGE_ID.test(value)
	) {
		throw new Error(
			`attachment storage: ${field} must be 1-${maxLength} ASCII letters, digits, underscores, or hyphens`,
		);
	}
	return value;
}

function shardFor(value: string): string {
	let hash = 0x811c9dc5;
	for (const byte of new TextEncoder().encode(value)) {
		hash = Math.imul(hash ^ byte, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 2);
}

export function storageKeyFor(
	workspaceId: string,
	attachmentId: string,
	kind: "content" | "thumbnail" = "content",
): string {
	if (kind !== "content" && kind !== "thumbnail") {
		throw new Error(`attachment storage: unknown object kind ${String(kind)}`);
	}
	const safeWorkspaceId = storageId(
		"workspaceId",
		workspaceId,
		MAX_STORAGE_SEGMENT_LENGTH,
	);
	const safeAttachmentId = storageId(
		"attachmentId",
		attachmentId,
		MAX_STORAGE_SEGMENT_LENGTH - THUMBNAIL_SUFFIX.length,
	);
	const suffix = kind === "thumbnail" ? THUMBNAIL_SUFFIX : "";
	return `${safeWorkspaceId}/${shardFor(safeAttachmentId)}/${safeAttachmentId}${suffix}`;
}
