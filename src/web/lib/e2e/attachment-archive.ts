import { byteNarrower } from "../../../domain/e2e/bytes.ts";
import { aad, decryptWrapped } from "../../../domain/e2e/envelope.ts";
import {
	decryptStream,
	type StreamPurpose,
} from "../../../domain/e2e/stream.ts";
import { decodeBytes, decodeWrapped } from "../../../domain/e2e/wire.ts";
import {
	AttachmentArchiveContractError,
	assertAttachmentArchiveObjectBinding,
	assertAttachmentArchivePortableRowBinding,
	attachmentArchiveAad,
	parseAttachmentArchiveContract,
	parseAttachmentArchiveManifestContract,
} from "../../../domain/portability/attachment-archive.ts";
import { parseImportDocument } from "../../../domain/portability/import-document.ts";
import { createDeriver, type Deriver } from "./derive.ts";

const bytes = byteNarrower("attachment archive");
async function sha256(value: Uint8Array): Promise<string> {
	const hash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", bytes(value)),
	);
	return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}
async function* chunks(value: Uint8Array) {
	for (let at = 0; at < value.length; at += 64 * 1024)
		yield value.subarray(at, at + 64 * 1024);
}

// This authenticates archive contents, not source-server provenance or destination authority.
export async function openAttachmentArchive(
	inputJSON: string,
	exactContentDocument: string,
	passphrase: string,
	options: { signal?: AbortSignal; createDeriver?: () => Deriver } = {},
) {
	const checkpoint = () => options.signal?.throwIfAborted();
	checkpoint();
	const archive = parseAttachmentArchiveContract(inputJSON);
	// Bound the accompanying document before allocating its UTF-8 bytes or starting KDF work.
	const document = parseImportDocument(exactContentDocument, {
		historyPreview: true,
	});
	const deriver = (options.createDeriver ?? createDeriver)();
	let disposed = false;
	const dispose = () => {
		if (!disposed) {
			disposed = true;
			deriver.dispose();
		}
	};
	let rejectAbort: (reason: unknown) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	const cancel = () => {
		rejectAbort(options.signal?.reason);
		dispose();
	};
	options.signal?.addEventListener("abort", cancel, { once: true });
	// Also erase sensitive results arriving after cancellation won the race.
	const wait = async <T>(promise: Promise<T>): Promise<T> => {
		const guarded = promise.then((value) => {
			if (options.signal?.aborted && value instanceof Uint8Array) value.fill(0);
			checkpoint();
			return value;
		});
		return Promise.race([guarded, aborted]);
	};
	let kek: Uint8Array | undefined;
	let manifestBytes: Uint8Array | undefined;
	try {
		checkpoint();
		kek = await wait(
			deriver.derive(
				passphrase,
				decodeBytes(archive.unlock.salt),
				"passphrase",
				1,
			),
		);
		manifestBytes = await wait(
			decryptWrapped(
				decodeWrapped(archive.protectedManifest),
				kek,
				attachmentArchiveAad(archive),
			),
		);
		const manifest = parseAttachmentArchiveManifestContract(
			new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes),
		);
		assertAttachmentArchiveObjectBinding(archive, manifest);
		if (
			(await wait(sha256(new TextEncoder().encode(exactContentDocument)))) !==
			manifest.contentDocument.exactBytesSha256
		)
			throw new AttachmentArchiveContractError("binding-mismatch");
		assertAttachmentArchivePortableRowBinding(manifest, document);
		const objects = new Map(
			archive.objects.map((object) => [object.entryId, object]),
		);
		for (const entry of manifest.entries) {
			checkpoint();
			const object = objects.get(entry.entryId);
			if (!object) throw new AttachmentArchiveContractError("binding-mismatch");
			const dek = decodeBytes(entry.locallyExportedDek);
			try {
				for (const field of ["filename", "contentType"] as const) {
					const plaintext = await wait(
						decryptWrapped(
							decodeWrapped(
								field === "filename"
									? entry.source.filenameCiphertext
									: entry.source.contentTypeCiphertext,
							),
							dek,
							aad.metadata(entry.source.id, field),
						),
					);
					try {
						checkpoint();
						new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
					} finally {
						plaintext.fill(0);
					}
				}
				for (const purpose of [
					"content",
					"thumbnail",
				] as const satisfies readonly StreamPurpose[]) {
					const payload = entry[purpose];
					const encoded = object[purpose];
					if (payload === null || encoded === null) continue;
					const ciphertext = decodeBytes(encoded);
					if ((await wait(sha256(ciphertext))) !== payload.sha256)
						throw new AttachmentArchiveContractError("binding-mismatch");
					for await (const plaintext of decryptStream(
						chunks(ciphertext),
						dek,
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
			} finally {
				dek.fill(0);
			}
		}
		checkpoint();
		return { archive, manifest };
	} finally {
		options.signal?.removeEventListener("abort", cancel);
		kek?.fill(0);
		manifestBytes?.fill(0);
		dispose();
	}
}
