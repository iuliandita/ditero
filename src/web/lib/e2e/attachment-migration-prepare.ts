import { isPreviewable, sanitiseFilename } from "../../../domain/attachment.ts";
import { byteNarrower } from "../../../domain/e2e/bytes.ts";
import {
	aad,
	decryptWrapped,
	encryptWrapped,
} from "../../../domain/e2e/envelope.ts";
import { decryptStream, encryptStream } from "../../../domain/e2e/stream.ts";
import {
	decodeBytes,
	decodeWrapped,
	encodeWrapped,
} from "../../../domain/e2e/wire.ts";
import {
	ATTACHMENT_ARCHIVE_LIMITS,
	AttachmentArchiveContractError,
	assertAttachmentArchiveObjectBinding,
} from "../../../domain/portability/attachment-archive.ts";
import { randomId } from "../../../domain/random-id.ts";
import type { openAttachmentArchive } from "./attachment-archive.ts";
import {
	createAttachmentThumbnail,
	type ThumbnailPlatform,
} from "./thumbnail.ts";

export type MigrationDestination = {
	workspaceId: string;
	parentKind: "list" | "task" | "comment";
	parentId: string;
	keyVersion: number;
	wdk: Uint8Array;
};
const bytes = byteNarrower("attachment migration");
const cap = ATTACHMENT_ARCHIVE_LIMITS.ciphertextBytes;
async function digest(value: Uint8Array) {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value))),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
}
async function* chunks(value: Uint8Array) {
	for (let at = 0; at < value.length; at += 65536)
		yield value.subarray(at, at + 65536);
}
function join(parts: readonly Uint8Array[]) {
	const output = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of parts) {
		output.set(part, at);
		at += part.length;
	}
	return output;
}

// The caller owns destination authority; this only prepares authenticated ciphertext.
export async function prepareAttachmentMigration(
	opened: Awaited<ReturnType<typeof openAttachmentArchive>>,
	entryId: string,
	target: MigrationDestination,
	options: {
		signal?: AbortSignal;
		checkpoint?: () => void;
		thumbnailPlatform?: ThumbnailPlatform;
	} = {},
) {
	const check = () => {
		options.signal?.throwIfAborted();
		options.checkpoint?.();
	};
	check();
	assertAttachmentArchiveObjectBinding(opened.archive, opened.manifest);
	const entry = opened.manifest.entries.find(
		(value) => value.entryId === entryId,
	);
	const object = opened.archive.objects.find(
		(value) => value.entryId === entryId,
	);
	if (!entry || !object)
		throw new AttachmentArchiveContractError("binding-mismatch");
	if (
		!(target.wdk instanceof Uint8Array) ||
		target.wdk.length !== 32 ||
		!Number.isSafeInteger(target.keyVersion) ||
		target.keyVersion < 1 ||
		target.keyVersion > 2147483647 ||
		[target.workspaceId, target.parentId].some(
			(value) =>
				typeof value !== "string" ||
				value.length < 1 ||
				value.length > 128 ||
				value.includes("\0") ||
				!value.isWellFormed(),
		) ||
		!["list", "task", "comment"].includes(target.parentKind)
	)
		throw new Error("migration: invalid destination");
	aad.metadata(target.parentId, "filename");
	const id = `migration_${randomId()}`;
	const keyAad = aad.dek(target.workspaceId, target.keyVersion, id);
	const destination = Object.freeze({
		workspaceId: target.workspaceId,
		parentKind: target.parentKind,
		parentId: target.parentId,
		keyVersion: target.keyVersion,
	});
	const wdk = new Uint8Array(target.wdk);
	const sourceDek = decodeBytes(entry.locallyExportedDek);
	const dek = crypto.getRandomValues(new Uint8Array(32));
	const rasterParts: Uint8Array[] = [];
	let rasterBytes: Uint8Array | undefined;
	let pngBytes: Uint8Array | undefined;
	const wait = async <T>(promise: Promise<T>) => {
		const value = await promise;
		try {
			check();
			return value;
		} catch (error) {
			if (value instanceof Uint8Array) value.fill(0);
			throw error;
		}
	};
	try {
		const metadata = async (field: "filename" | "contentType") => {
			const plaintext = await wait(
				decryptWrapped(
					decodeWrapped(
						field === "filename"
							? entry.source.filenameCiphertext
							: entry.source.contentTypeCiphertext,
					),
					sourceDek,
					aad.metadata(entry.source.id, field),
				),
			);
			try {
				return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
			} finally {
				plaintext.fill(0);
			}
		};
		const filename = sanitiseFilename(await metadata("filename"));
		const contentType = await metadata("contentType");
		if (
			!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) ||
			contentType.length > 255 ||
			["image/svg+xml", "text/html", "application/xhtml+xml"].includes(
				contentType,
			)
		)
			throw new Error("migration: unsafe content type");
		const raster = isPreviewable(contentType);
		if (entry.thumbnail !== null && !raster)
			throw new Error("migration: unsupported mandatory thumbnail");
		const authenticate = async (purpose: "content" | "thumbnail") => {
			const payload = entry[purpose];
			const encoded = object[purpose];
			if (payload === null || encoded === null)
				throw new AttachmentArchiveContractError("binding-mismatch");
			if (payload.bytes > cap || encoded.length > Math.ceil((cap * 4) / 3))
				throw new AttachmentArchiveContractError("byte-limit");
			const ciphertext = decodeBytes(encoded);
			if (
				ciphertext.length !== payload.bytes ||
				(await wait(digest(ciphertext))) !== payload.sha256
			)
				throw new AttachmentArchiveContractError("binding-mismatch");
			return ciphertext;
		};
		if (entry.thumbnail !== null) {
			for await (const plain of decryptStream(
				chunks(await authenticate("thumbnail")),
				sourceDek,
				"thumbnail",
			)) {
				try {
					check();
				} finally {
					plain.fill(0);
				}
			}
			check();
		}
		const contentCiphertext = await authenticate("content");
		async function* plaintext() {
			let count = 0;
			for await (const plain of decryptStream(
				chunks(contentCiphertext),
				sourceDek,
				"content",
			)) {
				try {
					check();
					count += plain.length;
					if (count > cap)
						throw new AttachmentArchiveContractError("byte-limit");
					if (raster) rasterParts.push(new Uint8Array(plain));
					yield plain;
				} finally {
					plain.fill(0);
				}
			}
			check();
		}
		const collect = async (
			source: AsyncIterable<Uint8Array>,
			remaining: number,
		) => {
			const parts: Uint8Array[] = [];
			let count = 0;
			for await (const part of source) {
				check();
				count += part.length;
				if (count > remaining)
					throw new AttachmentArchiveContractError("byte-limit");
				parts.push(part);
			}
			check();
			return join(parts);
		};
		const content = await collect(
			encryptStream(plaintext(), dek, "content"),
			cap,
		);
		let thumbnail: Uint8Array | null = null;
		if (raster) {
			rasterBytes = join(rasterParts);
			const png = await wait(
				createAttachmentThumbnail(
					new Blob([bytes(rasterBytes)], { type: contentType }),
					options.thumbnailPlatform,
				),
			);
			if (png?.type !== "image/png" || png.size > cap - content.length)
				throw new Error("migration: unsupported mandatory thumbnail");
			const authenticatedPng = await wait(
				png.arrayBuffer().then((value) => new Uint8Array(value)),
			);
			pngBytes = authenticatedPng;
			thumbnail = await collect(
				encryptStream(chunks(authenticatedPng), dek, "thumbnail"),
				cap - content.length,
			);
		}
		const seal = async (value: string, field: "filename" | "contentType") => {
			const plain = new TextEncoder().encode(value);
			try {
				return encodeWrapped(
					await wait(encryptWrapped(plain, dek, aad.metadata(id, field))),
				);
			} finally {
				plain.fill(0);
			}
		};
		const prepared = Object.freeze({
			id,
			keyVersion: destination.keyVersion,
			filenameCiphertext: await seal(filename, "filename"),
			contentTypeCiphertext: await seal(contentType, "contentType"),
			dekWrapped: encodeWrapped(await wait(encryptWrapped(dek, wdk, keyAad))),
			declaredBytes: content.length,
			ciphertextSha256: await wait(digest(content)),
			thumbnailDeclaredBytes: thumbnail?.length ?? null,
			thumbnailCiphertextSha256:
				thumbnail === null ? null : await wait(digest(thumbnail)),
		});
		check();
		// Copies prevent callers from changing the exact preparation kept for explicit retry.
		return Object.freeze({
			prepared,
			parent: Object.freeze({
				workspaceId: destination.workspaceId,
				parentKind: destination.parentKind,
				parentId: destination.parentId,
			}),
			get content() {
				return new Uint8Array(content);
			},
			get thumbnail() {
				return thumbnail === null ? null : new Uint8Array(thumbnail);
			},
		});
	} finally {
		sourceDek.fill(0);
		dek.fill(0);
		wdk.fill(0);
		rasterBytes?.fill(0);
		pngBytes?.fill(0);
		for (const part of rasterParts) part.fill(0);
	}
}
