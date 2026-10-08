import { isPreviewable, sanitiseFilename } from "../../../domain/attachment.ts";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import {
	DEK_BYTES,
	encryptedStreamLength,
	encryptStream,
} from "../../../domain/e2e/stream.ts";
import { encodeWrapped } from "../../../domain/e2e/wire.ts";
import { randomId } from "../../../domain/random-id.ts";
import { withCiphertextStage } from "./ciphertext-staging.ts";
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
	storageScope?: string;
	thumbnailer?: (file: File) => Promise<Blob | null>;
	signal?: AbortSignal;
	onProgress?: (progress: AttachmentUploadProgress) => void;
};

export type UploadedAttachment = {
	id: string;
	state: "committed";
};

export type AttachmentUploadFailure =
	| "file-too-large"
	| "quota-exceeded"
	| "rotation-required"
	| "key-unavailable"
	| "unknown";

export class AttachmentUploadError extends Error {
	constructor(
		readonly stage: AttachmentUploadPhase | "reserve" | "abort",
		readonly status: number,
		readonly reason: AttachmentUploadFailure,
	) {
		super(`attachment upload: ${stage} failed (${status}, ${reason})`);
		this.name = "AttachmentUploadError";
	}
}

export const BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES = 8 * 1024 * 1024;

export class AttachmentUploadCapabilityError extends Error {
	readonly limitBytes = BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES;
	constructor(
		readonly reason: "bounded-ciphertext-limit" | "transport-unavailable",
	) {
		super(`attachment upload: ${reason}`);
		this.name = "AttachmentUploadCapabilityError";
	}
}

export function getAttachmentUploadCapability(
	fetcher?: E2eFetcher,
): "stream" | "private-file" | "bounded-blob" | "unavailable" {
	if (fetcher !== undefined) return "stream";
	if (typeof XMLHttpRequest !== "function" || typeof Blob !== "function")
		return "unavailable";
	if (
		typeof navigator !== "undefined" &&
		typeof navigator.locks?.request === "function" &&
		typeof navigator.storage?.getDirectory === "function" &&
		typeof FileSystemFileHandle !== "undefined" &&
		typeof FileSystemFileHandle.prototype.createWritable === "function"
	)
		return "private-file";
	return "bounded-blob";
}

let blobUploadActive = false;
const blobUploadWaiters: Array<() => void> = [];

function acquireBlobUpload(signal?: AbortSignal): Promise<() => void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			const index = blobUploadWaiters.indexOf(start);
			if (index >= 0) blobUploadWaiters.splice(index, 1);
			reject(new DOMException("Upload aborted", "AbortError"));
		};
		const start = () => {
			signal?.removeEventListener("abort", abort);
			blobUploadActive = true;
			let released = false;
			resolve(() => {
				if (released) return;
				released = true;
				const next = blobUploadWaiters.shift();
				if (next) next();
				else blobUploadActive = false;
			});
		};
		if (signal?.aborted) {
			abort();
			return;
		}
		if (!blobUploadActive) start();
		else {
			blobUploadWaiters.push(start);
			signal?.addEventListener("abort", abort, { once: true });
		}
	});
}

const defaultFetcher: E2eFetcher = (input, init) => fetch(input, init);
const textEncoder = new TextEncoder();

async function* blobBytes(
	blob: Blob,
	signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
	const reader = blob.stream().getReader();
	const abort = () => {
		void reader.cancel().catch(() => undefined);
	};
	signal?.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			signal?.throwIfAborted();
			const next = await reader.read();
			signal?.throwIfAborted();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		signal?.removeEventListener("abort", abort);
		await reader.cancel().catch(() => undefined);
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
		const detail = await response.text().catch(() => "");
		const reason: AttachmentUploadFailure = [
			"file-too-large",
			"quota-exceeded",
			"rotation-required",
			"key-unavailable",
		].includes(detail)
			? (detail as AttachmentUploadFailure)
			: "unknown";
		throw new AttachmentUploadError(stage, response.status, reason);
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
	capability: ReturnType<typeof getAttachmentUploadCapability>,
): Promise<number> {
	if (capability === "private-file") {
		return await uploadCiphertextFromPrivateFile(
			url,
			plaintext,
			dek,
			purpose,
			loadedBefore,
			total,
			options,
		);
	}
	if (capability === "bounded-blob") {
		return await uploadCiphertextFromBlob(
			url,
			plaintext,
			dek,
			purpose,
			loadedBefore,
			total,
			options,
		);
	}
	if (capability === "unavailable")
		throw new AttachmentUploadCapabilityError("transport-unavailable");
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

function xhrUpload(
	url: string,
	body: Blob,
	signal: AbortSignal | undefined,
	onProgress: (loaded: number) => void,
): Promise<Response> {
	return new Promise((resolve, reject) => {
		const request = new XMLHttpRequest();
		let settled = false;
		const finish = (action: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			action();
		};
		const abort = () => {
			request.abort();
			finish(() => reject(new DOMException("Upload aborted", "AbortError")));
		};
		request.open("POST", url);
		request.withCredentials = true;
		request.setRequestHeader("content-type", "application/octet-stream");
		let loaded = 0;
		request.upload.onprogress = (event) => {
			if (settled) return;
			loaded = Math.max(loaded, Math.min(body.size, event.loaded));
			try {
				onProgress(loaded);
			} catch (error) {
				finish(() => reject(error));
				request.abort();
			}
		};
		request.onload = () =>
			finish(() => {
				try {
					resolve(
						new Response(request.responseText, {
							status: request.status,
							statusText: request.statusText,
						}),
					);
				} catch (error) {
					reject(error);
				}
			});
		request.onerror = () =>
			finish(() => reject(new TypeError("attachment upload: network failure")));
		request.onabort = () =>
			finish(() => reject(new DOMException("Upload aborted", "AbortError")));
		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
		try {
			request.send(body);
		} catch (error) {
			finish(() => reject(error));
		}
	});
}

async function uploadCiphertextFromBlob(
	url: string,
	plaintext: Blob,
	dek: Uint8Array,
	purpose: "content" | "thumbnail",
	loadedBefore: number,
	total: number,
	options: AttachmentUploadOptions,
): Promise<number> {
	const expected = encryptedStreamLength(plaintext.size);
	const chunks: Uint8Array<ArrayBuffer>[] = [];
	let observed = 0;
	try {
		options.signal?.throwIfAborted();
		for await (const chunk of encryptStream(
			blobBytes(plaintext, options.signal),
			dek,
			purpose,
		)) {
			options.signal?.throwIfAborted();
			observed += chunk.byteLength;
			if (
				observed > expected ||
				observed > BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES
			)
				throw new AttachmentUploadCapabilityError("bounded-ciphertext-limit");
			chunks.push(chunk.slice());
			options.onProgress?.({
				phase: "encrypting",
				loaded: loadedBefore,
				total,
			});
		}
		if (observed !== expected)
			throw new Error("attachment upload: ciphertext length mismatch");
		options.signal?.throwIfAborted();
		const body = new Blob(chunks, { type: "application/octet-stream" });
		chunks.length = 0;
		if (body.size !== expected)
			throw new Error("attachment upload: ciphertext length mismatch");
		await expectOk(
			await xhrUpload(url, body, options.signal, (loaded) => {
				options.onProgress?.({
					phase: "uploading",
					loaded: loadedBefore + loaded,
					total,
				});
			}),
			"uploading",
		);
		options.onProgress?.({
			phase: "uploading",
			loaded: loadedBefore + expected,
			total,
		});
		return loadedBefore + expected;
	} finally {
		chunks.length = 0;
	}
}

async function uploadCiphertextFromPrivateFile(
	url: string,
	plaintext: Blob,
	dek: Uint8Array,
	purpose: "content" | "thumbnail",
	loadedBefore: number,
	total: number,
	options: AttachmentUploadOptions,
): Promise<number> {
	return await withCiphertextStage(async (handle) => {
		const writable = await handle.createWritable();
		try {
			for await (const chunk of encryptStream(
				blobBytes(plaintext),
				dek,
				purpose,
			)) {
				if (options.signal?.aborted) {
					throw new DOMException("Upload aborted", "AbortError");
				}
				await writable.write(chunk.slice());
				options.onProgress?.({
					phase: "encrypting",
					loaded: loadedBefore,
					total,
				});
			}
			await writable.close();
			const ciphertext = await handle.getFile();
			await expectOk(
				await xhrUpload(url, ciphertext, options.signal, (loaded) => {
					options.onProgress?.({
						phase: "uploading",
						loaded: loadedBefore + loaded,
						total,
					});
				}),
				"uploading",
			);
			return loadedBefore + ciphertext.size;
		} catch (error) {
			await writable.abort().catch(() => undefined);
			throw error;
		}
	}, options.storageScope);
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
	const capability = getAttachmentUploadCapability(options.fetcher);
	const declaredBytes = encryptedStreamLength(input.file.size);
	if (capability === "unavailable")
		throw new AttachmentUploadCapabilityError("transport-unavailable");
	if (
		capability === "bounded-blob" &&
		declaredBytes > BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES
	)
		throw new AttachmentUploadCapabilityError("bounded-ciphertext-limit");
	options.signal?.throwIfAborted();
	const thumbnail = isPreviewable(contentType)
		? await (options.thumbnailer ?? createAttachmentThumbnail)(input.file)
		: null;
	const thumbnailDeclaredBytes = thumbnail
		? encryptedStreamLength(thumbnail.size)
		: null;
	const total = declaredBytes + (thumbnailDeclaredBytes ?? 0);
	if (
		capability === "bounded-blob" &&
		(!Number.isSafeInteger(total) ||
			total > BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES)
	)
		throw new AttachmentUploadCapabilityError("bounded-ciphertext-limit");
	options.signal?.throwIfAborted();
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
	let reserveAttempted = false;
	const release =
		capability === "bounded-blob"
			? await acquireBlobUpload(options.signal)
			: undefined;

	try {
		options.signal?.throwIfAborted();
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

		let uploaded = await uploadCiphertext(
			expectedUpload,
			input.file,
			dek,
			"content",
			0,
			total,
			options,
			capability,
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
				capability,
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
		release?.();
		if (reserveAttempted)
			await abortBestEffort(id, fetcher).catch(() => undefined);
		throw error;
	} finally {
		release?.();
	}
}
