import { isPreviewable, sanitiseFilename } from "../../../domain/attachment.ts";
import { aad, decryptWrapped } from "../../../domain/e2e/envelope.ts";
import {
	decryptStream,
	type StreamPurpose,
} from "../../../domain/e2e/stream.ts";
import { decodeWrapped } from "../../../domain/e2e/wire.ts";
import { withCiphertextStage } from "./ciphertext-staging.ts";
import type { E2eFetcher } from "./workspace-keys.ts";

export const MEMORY_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export class DownloadMemoryLimitError extends Error {
	constructor() {
		super("attachment download: file exceeds the in-memory download limit");
		this.name = "DownloadMemoryLimitError";
	}
}

export type AttachmentCiphertextMetadata = {
	id: string;
	workspaceId: string;
	keyVersion: number;
	filenameCiphertext: string;
	contentTypeCiphertext: string;
	dekWrapped: string;
	thumbnailStorageKey?: string | null;
};

export type PlaintextSink = {
	write: (chunk: Uint8Array) => Promise<void>;
	finish: (contentType: string) => Promise<Blob>;
	abort: () => Promise<void>;
};

export type AttachmentDownloadOptions = {
	fetcher?: E2eFetcher;
	createSink?: () => Promise<PlaintextSink>;
	urls?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
	signal?: AbortSignal;
	onProgress?: (progress: AttachmentDownloadProgress) => void;
};

export type AttachmentDownloadProgress = {
	phase: "transferring" | "decrypting";
	loaded: number;
	total: number;
};

export type DecryptedAttachmentMetadata = {
	filename: string;
	contentType: string;
};

export type DownloadedAttachment = DecryptedAttachmentMetadata & {
	blob: Blob;
	url: string;
	revoke: () => void;
};

const defaultFetcher: E2eFetcher = (input, init) => fetch(input, init);
const decoder = new TextDecoder("utf-8", { fatal: true });

async function unwrapDek(
	row: AttachmentCiphertextMetadata,
	wdk: Uint8Array,
): Promise<Uint8Array> {
	return await decryptWrapped(
		decodeWrapped(row.dekWrapped),
		wdk,
		aad.dek(row.workspaceId, row.keyVersion, row.id),
	);
}

async function decryptMetadataWithDek(
	row: AttachmentCiphertextMetadata,
	dek: Uint8Array,
): Promise<DecryptedAttachmentMetadata> {
	const [filename, contentType] = await Promise.all([
		decryptWrapped(
			decodeWrapped(row.filenameCiphertext),
			dek,
			aad.metadata(row.id, "filename"),
		),
		decryptWrapped(
			decodeWrapped(row.contentTypeCiphertext),
			dek,
			aad.metadata(row.id, "contentType"),
		),
	]);
	return {
		filename: sanitiseFilename(decoder.decode(filename)),
		contentType: decoder.decode(contentType),
	};
}

export async function decryptAttachmentMetadata(
	row: AttachmentCiphertextMetadata,
	wdk: Uint8Array,
): Promise<DecryptedAttachmentMetadata> {
	return await decryptMetadataWithDek(row, await unwrapDek(row, wdk));
}

async function* responseBytes(
	stream: ReadableStream<Uint8Array>,
	onChunk: (bytes: number) => void,
): AsyncIterable<Uint8Array> {
	const reader = stream.getReader();
	let complete = false;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) {
				complete = true;
				return;
			}
			onChunk(next.value.byteLength);
			yield next.value;
		}
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function memorySink(): Promise<PlaintextSink> {
	const chunks: ArrayBuffer[] = [];
	let size = 0;
	return {
		async write(chunk) {
			if (size + chunk.byteLength > MEMORY_DOWNLOAD_BYTES)
				throw new DownloadMemoryLimitError();
			size += chunk.byteLength;
			chunks.push(chunk.slice().buffer as ArrayBuffer);
		},
		async finish(contentType) {
			const blob = new Blob(chunks, { type: contentType });
			chunks.length = 0;
			return blob;
		},
		async abort() {
			chunks.length = 0;
		},
	};
}

async function download(
	row: AttachmentCiphertextMetadata,
	wdk: Uint8Array,
	purpose: StreamPurpose,
	options: AttachmentDownloadOptions,
): Promise<DownloadedAttachment> {
	const fetcher = options.fetcher ?? defaultFetcher;
	const dek = await unwrapDek(row, wdk);
	const metadata = await decryptMetadataWithDek(row, dek);
	if (purpose === "thumbnail") {
		if (!isPreviewable(metadata.contentType)) {
			throw new Error("attachment download: original type is not previewable");
		}
		if (!row.thumbnailStorageKey) {
			throw new Error("attachment download: thumbnail is unavailable");
		}
	}
	const suffix = purpose === "thumbnail" ? "thumbnail" : "download";
	const response = await fetcher(
		`/api/attachments/${encodeURIComponent(row.id)}/${suffix}`,
		{ credentials: "include", signal: options.signal },
	);
	if (!response.ok) {
		throw new Error(
			`attachment download: transfer failed (${response.status})`,
		);
	}
	if (!response.body)
		throw new Error("attachment download: response has no body");
	const rawLength = response.headers.get("content-length");
	const total =
		rawLength !== null &&
		/^\d+$/.test(rawLength) &&
		Number.isSafeInteger(Number(rawLength))
			? Number(rawLength)
			: 0;
	if (!options.createSink && total > MEMORY_DOWNLOAD_BYTES) {
		await response.body.cancel();
		throw new DownloadMemoryLimitError();
	}
	let loaded = 0;
	options.onProgress?.({ phase: "transferring", loaded, total });

	const sink = await (options.createSink ?? memorySink)();
	try {
		for await (const chunk of decryptStream(
			responseBytes(response.body, (bytes) => {
				loaded += bytes;
				options.onProgress?.({ phase: "transferring", loaded, total });
			}),
			dek,
			purpose,
		)) {
			options.signal?.throwIfAborted();
			await sink.write(chunk);
		}
		options.onProgress?.({
			phase: "decrypting",
			loaded,
			total: total || loaded,
		});
		const blobType =
			purpose === "thumbnail"
				? "image/png"
				: isPreviewable(metadata.contentType)
					? metadata.contentType
					: "application/octet-stream";
		options.signal?.throwIfAborted();
		const blob = await sink.finish(blobType);
		options.signal?.throwIfAborted();
		const urls = options.urls ?? URL;
		const url = urls.createObjectURL(blob);
		let revoked = false;
		return {
			...metadata,
			contentType: blobType,
			blob,
			url,
			revoke() {
				if (revoked) return;
				revoked = true;
				urls.revokeObjectURL(url);
			},
		};
	} catch (error) {
		await sink.abort().catch(() => undefined);
		throw error;
	}
}

export function downloadAttachment(
	row: AttachmentCiphertextMetadata,
	wdk: Uint8Array,
	options: AttachmentDownloadOptions = {},
): Promise<DownloadedAttachment> {
	return download(row, wdk, "content", options);
}

export function downloadAttachmentThumbnail(
	row: AttachmentCiphertextMetadata,
	wdk: Uint8Array,
	options: AttachmentDownloadOptions = {},
): Promise<DownloadedAttachment> {
	return download(row, wdk, "thumbnail", options);
}

export function supportsFileDownload(): boolean {
	return (
		typeof window !== "undefined" &&
		typeof (window as Window & { showSaveFilePicker?: SaveFilePicker })
			.showSaveFilePicker === "function" &&
		typeof navigator !== "undefined" &&
		Boolean(navigator.locks && navigator.storage?.getDirectory)
	);
}

type SaveFilePicker = (options: {
	suggestedName: string;
}) => Promise<FileSystemFileHandle>;

// Called directly from the click handler, before asynchronous key access consumes activation.
export function pickDownloadFile(
	filename: string,
): Promise<FileSystemFileHandle> {
	const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker })
		.showSaveFilePicker;
	if (!picker) throw new DownloadMemoryLimitError();
	return picker.call(window, { suggestedName: sanitiseFilename(filename) });
}

type FileDownloadOptions = AttachmentDownloadOptions & {
	withStage?: typeof withCiphertextStage;
};

export async function saveAttachmentToFile(
	row: AttachmentCiphertextMetadata,
	wdk: Uint8Array,
	destination: Pick<FileSystemFileHandle, "createWritable">,
	options: FileDownloadOptions = {},
): Promise<void> {
	const dek = await unwrapDek(row, wdk);
	let body: ReadableStream<Uint8Array> | null = null;
	try {
		const response = await (options.fetcher ?? defaultFetcher)(
			`/api/attachments/${encodeURIComponent(row.id)}/download`,
			{ credentials: "include", signal: options.signal },
		);
		body = response.body;
		if (!response.ok || !body) {
			throw new Error(
				`attachment download: transfer failed (${response.status})`,
			);
		}
		const source = body;
		const rawLength = response.headers.get("content-length");
		const total =
			rawLength !== null &&
			/^\d+$/.test(rawLength) &&
			Number.isSafeInteger(Number(rawLength))
				? Number(rawLength)
				: 0;
		let loaded = 0;
		await (options.withStage ?? withCiphertextStage)(async (handle) => {
			const stageWriter = await handle.createWritable();
			try {
				for await (const chunk of responseBytes(source, (count) => {
					loaded += count;
					options.onProgress?.({ phase: "transferring", loaded, total });
				})) {
					options.signal?.throwIfAborted();
					await stageWriter.write(chunk as Uint8Array<ArrayBuffer>);
				}
				await stageWriter.close();
			} catch (error) {
				await stageWriter.abort().catch(() => undefined);
				throw error;
			}
			const ciphertext = await handle.getFile();
			// Keep the same File snapshot for both passes. Only ciphertext enters OPFS.
			// A successful first pass proves completeness before any destination write.
			for await (const chunk of decryptStream(
				responseBytes(ciphertext.stream(), () =>
					options.signal?.throwIfAborted(),
				),
				dek,
				"content",
			)) {
				chunk.fill(0);
			}
			options.signal?.throwIfAborted();
			options.onProgress?.({
				phase: "decrypting",
				loaded,
				total: total || loaded,
			});
			const output = await destination.createWritable();
			try {
				for await (const chunk of decryptStream(
					responseBytes(ciphertext.stream(), () =>
						options.signal?.throwIfAborted(),
					),
					dek,
					"content",
				)) {
					await output.write(chunk as Uint8Array<ArrayBuffer>);
					chunk.fill(0);
				}
				options.signal?.throwIfAborted();
				await output.close();
			} catch (error) {
				await output.abort().catch(() => undefined);
				throw error;
			}
		});
	} finally {
		if (body && !body.locked) await body.cancel().catch(() => undefined);
		dek.fill(0);
	}
}
