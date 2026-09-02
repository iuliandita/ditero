import { isPreviewable, sanitiseFilename } from "../../../domain/attachment.ts";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import {
	DEK_BYTES,
	encryptedStreamLength,
	encryptStream,
} from "../../../domain/e2e/stream.ts";
import { encodeWrapped } from "../../../domain/e2e/wire.ts";
import { randomId } from "../../../domain/random-id.ts";
import { createAttachmentThumbnail } from "./thumbnail.ts";
import type { E2eFetcher } from "./workspace-keys.ts";

type AttachmentParentKind = "task" | "comment" | "list";

export type AttachmentUploadInput = {
	file: File;
	workspaceId: string;
	parentKind: AttachmentParentKind;
	parentId: string;
	keyVersion: number;
	wdk: Uint8Array;
};

export type AttachmentUploadPhase = "encrypting" | "uploading" | "finalizing";

export type AttachmentUploadProgress = {
	phase: AttachmentUploadPhase;
	loaded: number;
	total: number;
};

export type AttachmentUploadOptions = {
	id?: string;
	fetcher?: E2eFetcher;
	thumbnailer?: (file: File) => Promise<Blob | null>;
	signal?: AbortSignal;
	onProgress?: (progress: AttachmentUploadProgress) => void;
};

export type UploadedAttachment = {
	id: string;
	state: "committed";
};

const defaultFetcher: E2eFetcher = (input, init) => fetch(input, init);
const textEncoder = new TextEncoder();

async function* blobBytes(blob: Blob): AsyncIterable<Uint8Array> {
	const reader = blob.stream().getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		reader.releaseLock();
	}
}

function streamBody(
	source: AsyncIterable<Uint8Array>,
	onChunk: (bytes: number) => void,
): ReadableStream<Uint8Array> {
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) {
					controller.close();
					return;
				}
				onChunk(next.value.byteLength);
				controller.enqueue(next.value);
			} catch (error) {
				controller.error(error);
			}
		},
		async cancel() {
			await iterator.return?.();
		},
	});
}

function streamingPost(body: ReadableStream<Uint8Array>, signal?: AbortSignal) {
	return {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/octet-stream" },
		body,
		signal,
		duplex: "half",
	} as RequestInit & { duplex: "half" };
}

async function expectOk(
	response: Response,
	stage: AttachmentUploadPhase | "reserve" | "abort",
): Promise<Response> {
	if (!response.ok) {
		throw new Error(`attachment upload: ${stage} failed (${response.status})`);
	}
	return response;
}

async function abortBestEffort(id: string, fetcher: E2eFetcher): Promise<void> {
	await fetcher("/api/attachments/abort", {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	}).then((response) => expectOk(response, "abort"));
}

async function uploadCiphertext(
	url: string,
	plaintext: Blob,
	dek: Uint8Array,
	purpose: "content" | "thumbnail",
	loadedBefore: number,
	total: number,
	options: AttachmentUploadOptions,
): Promise<number> {
	let loaded = loadedBefore;
	const body = streamBody(
		encryptStream(blobBytes(plaintext), dek, purpose),
		(n) => {
			loaded += n;
			options.onProgress?.({ phase: "uploading", loaded, total });
		},
	);
	await expectOk(
		await (options.fetcher ?? defaultFetcher)(
			url,
			streamingPost(body, options.signal),
		),
		"uploading",
	);
	return loaded;
}

export async function uploadAttachment(
	input: AttachmentUploadInput,
	options: AttachmentUploadOptions = {},
): Promise<UploadedAttachment> {
	const fetcher = options.fetcher ?? defaultFetcher;
	const id = options.id ?? randomId();
	const filename = sanitiseFilename(input.file.name);
	const contentType = input.file.type || "application/octet-stream";
	options.onProgress?.({
		phase: "encrypting",
		loaded: 0,
		total: input.file.size,
	});
	const thumbnail = isPreviewable(contentType)
		? await (options.thumbnailer ?? createAttachmentThumbnail)(input.file)
		: null;
	const dek = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
	const filenameCiphertext = encodeWrapped(
		await encryptWrapped(
			textEncoder.encode(filename),
			dek,
			aad.metadata(id, "filename"),
		),
	);
	const contentTypeCiphertext = encodeWrapped(
		await encryptWrapped(
			textEncoder.encode(contentType),
			dek,
			aad.metadata(id, "contentType"),
		),
	);
	const dekWrapped = encodeWrapped(
		await encryptWrapped(
			dek,
			input.wdk,
			aad.dek(input.workspaceId, input.keyVersion, id),
		),
	);
	const declaredBytes = encryptedStreamLength(input.file.size);
	const thumbnailDeclaredBytes = thumbnail
		? encryptedStreamLength(thumbnail.size)
		: null;
	let reserveAttempted = false;

	try {
		reserveAttempted = true;
		const reserve = await expectOk(
			await fetcher("/api/attachments/reserve", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					id,
					workspaceId: input.workspaceId,
					parentKind: input.parentKind,
					parentId: input.parentId,
					keyVersion: input.keyVersion,
					filenameCiphertext,
					contentTypeCiphertext,
					dekWrapped,
					declaredBytes,
					thumbnailDeclaredBytes,
				}),
				signal: options.signal,
			}),
			"reserve",
		);
		const target = (await reserve.json()) as {
			id?: unknown;
			uploadUrl?: unknown;
			thumbnailUploadUrl?: unknown;
		};
		const expectedUpload = `/api/attachments/${encodeURIComponent(id)}/upload`;
		const expectedThumbnail = thumbnail
			? `/api/attachments/${encodeURIComponent(id)}/thumbnail`
			: null;
		if (
			target.id !== id ||
			target.uploadUrl !== expectedUpload ||
			target.thumbnailUploadUrl !== expectedThumbnail
		) {
			throw new Error("attachment upload: reserve returned an invalid target");
		}

		const total = declaredBytes + (thumbnailDeclaredBytes ?? 0);
		let uploaded = await uploadCiphertext(
			expectedUpload,
			input.file,
			dek,
			"content",
			0,
			total,
			options,
		);
		if (thumbnail && expectedThumbnail) {
			uploaded = await uploadCiphertext(
				expectedThumbnail,
				thumbnail,
				dek,
				"thumbnail",
				uploaded,
				total,
				options,
			);
		}
		options.onProgress?.({ phase: "finalizing", loaded: uploaded, total });
		const finalized = await expectOk(
			await fetcher("/api/attachments/finalize", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
				signal: options.signal,
			}),
			"finalizing",
		);
		const result = (await finalized.json()) as {
			id?: unknown;
			state?: unknown;
		};
		if (result.id !== id || result.state !== "committed") {
			throw new Error("attachment upload: finalize returned an invalid result");
		}
		return { id, state: "committed" };
	} catch (error) {
		if (reserveAttempted)
			await abortBestEffort(id, fetcher).catch(() => undefined);
		throw error;
	}
}
