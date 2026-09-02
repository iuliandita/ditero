import { isPreviewable, sanitiseFilename } from "../../../domain/attachment.ts";
import { aad, decryptWrapped } from "../../../domain/e2e/envelope.ts";
import {
	decryptStream,
	type StreamPurpose,
} from "../../../domain/e2e/stream.ts";
import { decodeWrapped } from "../../../domain/e2e/wire.ts";
import type { E2eFetcher } from "./workspace-keys.ts";

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
			yield next.value;
		}
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

async function memorySink(): Promise<PlaintextSink> {
	const chunks: ArrayBuffer[] = [];
	return {
		async write(chunk) {
			chunks.push(chunk.slice().buffer as ArrayBuffer);
		},
		async finish(contentType) {
			return new Blob(chunks, { type: contentType });
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

	const sink = await (options.createSink ?? memorySink)();
	try {
		for await (const chunk of decryptStream(
			responseBytes(response.body),
			dek,
			purpose,
		)) {
			await sink.write(chunk);
		}
		const blobType =
			purpose === "thumbnail"
				? "image/png"
				: isPreviewable(metadata.contentType)
					? metadata.contentType
					: "application/octet-stream";
		const blob = await sink.finish(blobType);
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
