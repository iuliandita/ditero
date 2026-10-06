import { byteNarrower } from "../../../domain/e2e/bytes.ts";
import {
	aad,
	decryptWrapped,
	encryptWrapped,
} from "../../../domain/e2e/envelope.ts";
import { decryptStream } from "../../../domain/e2e/stream.ts";
import {
	decodeBytes,
	decodeWrapped,
	encodeBytes,
	encodeWrapped,
} from "../../../domain/e2e/wire.ts";
import {
	ATTACHMENT_ARCHIVE_LIMITS,
	AttachmentArchiveContractError,
	type AttachmentArchiveManifestContract,
	assertAttachmentArchiveObjectBinding,
	assertAttachmentArchivePortableRowBinding,
	attachmentArchiveAad,
	parseAttachmentArchiveContract,
	parseAttachmentArchiveManifestContract,
} from "../../../domain/portability/attachment-archive.ts";
import { parseImportDocument } from "../../../domain/portability/import-document.ts";
import { randomId } from "../../../domain/random-id.ts";
import { createDeriver, type Deriver } from "./derive.ts";

// The caller must authorize each committed download and unwrap its original
// DEK with the original workspace key/AAD. This helper has neither authority.
export type AuthorizedArchiveSource = {
	source: AttachmentArchiveManifestContract["entries"][number]["source"];
	dek: Uint8Array;
	content: Uint8Array;
	thumbnail: Uint8Array | null;
};
const bytes = byteNarrower("attachment archive export");
const encoder = new TextEncoder();
async function sha256(value: Uint8Array): Promise<string> {
	return Array.from(
		new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value))),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}
async function* chunks(value: Uint8Array) {
	for (let at = 0; at < value.length; at += 64 * 1024)
		yield value.subarray(at, at + 64 * 1024);
}

export async function exportAttachmentArchive(
	exactContentDocument: string,
	selected: readonly AuthorizedArchiveSource[],
	passphrase: string,
	options: { signal?: AbortSignal; createDeriver?: () => Deriver } = {},
) {
	const checkpoint = () => options.signal?.throwIfAborted();
	checkpoint();
	const document = parseImportDocument(exactContentDocument, {
		historyPreview: true,
	});
	if (
		!Array.isArray(selected) ||
		selected.length === 0 ||
		selected.length > ATTACHMENT_ARCHIVE_LIMITS.entries
	)
		throw new AttachmentArchiveContractError("byte-limit");
	let total = 0;
	for (const item of selected) {
		if (
			!(item.dek instanceof Uint8Array) ||
			item.dek.length !== 32 ||
			!(item.content instanceof Uint8Array) ||
			(item.thumbnail !== null && !(item.thumbnail instanceof Uint8Array))
		)
			throw new AttachmentArchiveContractError("invalid-contract");
		bytes(item.dek);
		bytes(item.content);
		if (item.thumbnail !== null) bytes(item.thumbnail);
		if (
			!Number.isSafeInteger(item.source.keyVersion) ||
			item.source.keyVersion < 1 ||
			!["task", "comment", "list"].includes(item.source.parentKind)
		)
			throw new AttachmentArchiveContractError("invalid-contract");
		total += item.content.length + (item.thumbnail?.length ?? 0);
		if (total > ATTACHMENT_ARCHIVE_LIMITS.ciphertextBytes)
			throw new AttachmentArchiveContractError("byte-limit");
		for (const field of [
			"filenameCiphertext",
			"contentTypeCiphertext",
			"dekWrapped",
		] as const)
			if (
				typeof item.source[field] !== "string" ||
				item.source[field].length > 65536
			)
				throw new AttachmentArchiveContractError("invalid-contract");
		for (const field of ["id", "workspaceId", "parentId"] as const)
			if (
				typeof item.source[field] !== "string" ||
				item.source[field].length > 128
			)
				throw new AttachmentArchiveContractError("invalid-contract");
	}
	// Capture before any await. Caller-owned keys and buffers remain untouched.
	const owned: AuthorizedArchiveSource[] = [];
	let deriver: Deriver | undefined;
	let disposed = false;
	const dispose = () => {
		if (deriver && !disposed) {
			disposed = true;
			deriver.dispose();
		}
	};
	let rejectAbort: (reason: unknown) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	// Cancellation can occur while a stream segment is authenticating.
	void aborted.catch(() => {});
	const cancel = () => {
		rejectAbort(options.signal?.reason);
		dispose();
	};
	options.signal?.addEventListener("abort", cancel, { once: true });
	const wait = async <T>(promise: Promise<T>): Promise<T> =>
		Promise.race([
			promise.then((value) => {
				if (options.signal?.aborted && value instanceof Uint8Array)
					value.fill(0);
				checkpoint();
				return value;
			}),
			aborted,
		]);
	let kek: Uint8Array | undefined;
	let manifestBytes: Uint8Array | undefined;
	try {
		for (const item of selected)
			owned.push({
				source: {
					id: item.source.id,
					workspaceId: item.source.workspaceId,
					keyVersion: item.source.keyVersion,
					parentKind: item.source.parentKind,
					parentId: item.source.parentId,
					filenameCiphertext: item.source.filenameCiphertext,
					contentTypeCiphertext: item.source.contentTypeCiphertext,
					dekWrapped: item.source.dekWrapped,
				},
				dek: new Uint8Array(item.dek),
				content: new Uint8Array(item.content),
				thumbnail:
					item.thumbnail === null ? null : new Uint8Array(item.thumbnail),
			});
		checkpoint();
		const archiveId = randomId();
		const unlock = {
			kdfVersion: 1 as const,
			salt: encodeBytes(crypto.getRandomValues(new Uint8Array(16))),
		};
		const entries: AttachmentArchiveManifestContract["entries"][number][] = [];
		for (const item of owned) {
			entries.push({
				entryId: randomId(),
				source: item.source,
				locallyExportedDek: encodeBytes(item.dek),
				content: {
					bytes: item.content.length,
					sha256: await wait(sha256(item.content)),
				},
				thumbnail:
					item.thumbnail === null
						? null
						: {
								bytes: item.thumbnail.length,
								sha256: await wait(sha256(item.thumbnail)),
							},
			});
		}
		const manifest = parseAttachmentArchiveManifestContract(
			JSON.stringify({
				archiveId,
				exportedAt: new Date().toISOString(),
				contentDocument: {
					format: "ditero",
					schemaVersion: document.schemaVersion,
					exactBytesSha256: await wait(
						sha256(encoder.encode(exactContentDocument)),
					),
					sourceUserId: document.sourceUserId,
					sourceNamespace:
						document.schemaVersion === 2 ? document.sourceNamespace : null,
				},
				entries,
			}),
		);
		// This checks the exact UTF-8 manifest cap before allocating a KDF worker.
		assertAttachmentArchivePortableRowBinding(manifest, document);
		manifestBytes = encoder.encode(JSON.stringify(manifest));
		for (const item of owned) {
			for (const field of ["filename", "contentType"] as const) {
				const plaintext = await wait(
					decryptWrapped(
						decodeWrapped(
							field === "filename"
								? item.source.filenameCiphertext
								: item.source.contentTypeCiphertext,
						),
						item.dek,
						aad.metadata(item.source.id, field),
					),
				);
				try {
					checkpoint();
					new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
				} finally {
					plaintext.fill(0);
				}
			}
			for (const purpose of ["content", "thumbnail"] as const) {
				const ciphertext = item[purpose];
				if (ciphertext === null) continue;
				for await (const plaintext of decryptStream(
					chunks(ciphertext),
					item.dek,
					purpose,
				)) {
					try {
						checkpoint();
					} finally {
						plaintext.fill(0);
					}
				}
				checkpoint();
			}
		}
		checkpoint();
		deriver = (options.createDeriver ?? createDeriver)();
		checkpoint();
		kek = await wait(
			deriver.derive(passphrase, decodeBytes(unlock.salt), "passphrase", 1),
		);
		const protectedManifest = encodeWrapped(
			await wait(
				encryptWrapped(
					manifestBytes,
					kek,
					attachmentArchiveAad({ archiveId, unlock }),
				),
			),
		);
		const archive = parseAttachmentArchiveContract(
			JSON.stringify({
				format: "ditero-attachment-archive",
				schemaVersion: 1,
				archiveId,
				unlock,
				protectedManifest,
				objects: owned.map((item, index) => ({
					entryId: manifest.entries[index]?.entryId,
					content: encodeBytes(item.content),
					thumbnail:
						item.thumbnail === null ? null : encodeBytes(item.thumbnail),
				})),
			}),
		);
		assertAttachmentArchiveObjectBinding(archive, manifest);
		checkpoint();
		return { archive, json: JSON.stringify(archive) };
	} finally {
		options.signal?.removeEventListener("abort", cancel);
		for (const item of owned) item.dek.fill(0);
		kek?.fill(0);
		manifestBytes?.fill(0);
		dispose();
	}
}
