import { describe, expect, test, vi } from "vitest";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { encryptStream } from "../../../domain/e2e/stream.ts";
import { encodeWrapped } from "../../../domain/e2e/wire.ts";
import {
	DownloadMemoryLimitError,
	downloadAttachment,
	downloadAttachmentThumbnail,
	MEMORY_DOWNLOAD_BYTES,
	type PlaintextSink,
	saveAttachmentToFile,
} from "./download.ts";

async function collect(source: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	for await (const chunk of source) {
		chunks.push(chunk);
		length += chunk.length;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

async function* source(bytes: Uint8Array): AsyncIterable<Uint8Array> {
	yield bytes;
}

function response(bytes: Uint8Array): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
	);
}

async function fixture(contentType = "image/png") {
	const id = "attachment-1";
	const workspaceId = "workspace-1";
	const keyVersion = 2;
	const wdk = crypto.getRandomValues(new Uint8Array(32));
	const dek = crypto.getRandomValues(new Uint8Array(32));
	return {
		wdk,
		dek,
		row: {
			id,
			workspaceId,
			keyVersion,
			filenameCiphertext: encodeWrapped(
				await encryptWrapped(
					new TextEncoder().encode("../photo.png"),
					dek,
					aad.metadata(id, "filename"),
				),
			),
			contentTypeCiphertext: encodeWrapped(
				await encryptWrapped(
					new TextEncoder().encode(contentType),
					dek,
					aad.metadata(id, "contentType"),
				),
			),
			dekWrapped: encodeWrapped(
				await encryptWrapped(dek, wdk, aad.dek(workspaceId, keyVersion, id)),
			),
			thumbnailStorageKey: "opaque-thumbnail-key",
		},
	};
}

function recordingSink() {
	const chunks: Uint8Array[] = [];
	const sink: PlaintextSink = {
		write: vi.fn(async (chunk) => {
			chunks.push(new Uint8Array(chunk));
		}),
		finish: vi.fn(
			async (contentType) =>
				new Blob(
					chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer),
					{
						type: contentType,
					},
				),
		),
		abort: vi.fn(async () => undefined),
	};
	return { sink, chunks };
}

describe("downloadAttachment", () => {
	test("reveals a blob URL only after the final segment authenticates", async () => {
		const { row, wdk, dek } = await fixture();
		const plaintext = new TextEncoder().encode("private image bytes");
		const ciphertext = await collect(
			encryptStream(source(plaintext), dek, "content", 1024),
		);
		const temporary = recordingSink();
		const events: string[] = [];
		const createObjectURL = vi.fn((blob: Blob) => {
			events.push("reveal");
			expect(temporary.sink.finish).toHaveBeenCalledOnce();
			expect(blob.type).toBe("image/png");
			return "blob:attachment";
		});
		const revokeObjectURL = vi.fn();
		const progress: Array<{ phase: string; loaded: number; total: number }> =
			[];

		const result = await downloadAttachment(row, wdk, {
			fetcher: async () =>
				new Response(response(ciphertext).body, {
					headers: { "content-length": String(ciphertext.length) },
				}),
			createSink: async () => temporary.sink,
			urls: { createObjectURL, revokeObjectURL },
			onProgress: (event) => progress.push(event),
		});

		expect(result.url).toBe("blob:attachment");
		expect(result.filename).toBe("photo.png");
		expect(result.contentType).toBe("image/png");
		expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(plaintext);
		expect(events).toEqual(["reveal"]);
		expect(progress.at(0)).toEqual({
			phase: "transferring",
			loaded: 0,
			total: ciphertext.length,
		});
		expect(progress).toContainEqual({
			phase: "transferring",
			loaded: ciphertext.length,
			total: ciphertext.length,
		});
		expect(progress.at(-1)).toEqual({
			phase: "decrypting",
			loaded: ciphertext.length,
			total: ciphertext.length,
		});
		result.revoke();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment");
	});

	test("discards authenticated prefix segments when the final segment is tampered", async () => {
		const { row, wdk, dek } = await fixture();
		const plaintext = crypto.getRandomValues(new Uint8Array(2500));
		const ciphertext = await collect(
			encryptStream(source(plaintext), dek, "content", 1024),
		);
		ciphertext[ciphertext.length - 1] = (ciphertext.at(-1) ?? 0) ^ 1;
		const temporary = recordingSink();
		const createObjectURL = vi.fn(() => "blob:must-not-exist");

		await expect(
			downloadAttachment(row, wdk, {
				fetcher: async () => response(ciphertext),
				createSink: async () => temporary.sink,
				urls: { createObjectURL, revokeObjectURL: vi.fn() },
			}),
		).rejects.toThrow();
		expect(temporary.sink.write).toHaveBeenCalled();
		expect(temporary.sink.finish).not.toHaveBeenCalled();
		expect(temporary.sink.abort).toHaveBeenCalledOnce();
		expect(createObjectURL).not.toHaveBeenCalled();
	});

	test("cancels the network body when framing fails before EOF", async () => {
		const { row, wdk } = await fixture();
		const cancelled = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(33));
			},
			cancel: cancelled,
		});
		const temporary = recordingSink();

		await expect(
			downloadAttachment(row, wdk, {
				fetcher: async () => new Response(body),
				createSink: async () => temporary.sink,
			}),
		).rejects.toThrow(/Ditero stream/);
		expect(cancelled).toHaveBeenCalledOnce();
		expect(temporary.sink.abort).toHaveBeenCalledOnce();
	});

	test("decrypts thumbnails under the separate purpose and forces PNG", async () => {
		const { row, wdk, dek } = await fixture();
		const plaintext = new TextEncoder().encode("thumbnail pixels");
		const ciphertext = await collect(
			encryptStream(source(plaintext), dek, "thumbnail", 1024),
		);
		const temporary = recordingSink();
		const fetcher = vi.fn(async () => response(ciphertext));

		const result = await downloadAttachmentThumbnail(row, wdk, {
			fetcher,
			createSink: async () => temporary.sink,
			urls: { createObjectURL: () => "blob:thumb", revokeObjectURL: vi.fn() },
		});

		expect(fetcher).toHaveBeenCalledWith(
			"/api/attachments/attachment-1/thumbnail",
			expect.objectContaining({ credentials: "include" }),
		);
		expect(result.contentType).toBe("image/png");
		expect(new Uint8Array(await result.blob.arrayBuffer())).toEqual(plaintext);
	});

	test("never fetches a thumbnail for an active original type", async () => {
		const { row, wdk } = await fixture("image/svg+xml");
		const fetcher = vi.fn();

		await expect(
			downloadAttachmentThumbnail(row, wdk, { fetcher }),
		).rejects.toThrow(/previewable/);
		expect(fetcher).not.toHaveBeenCalled();
	});
});

function fileStage() {
	const pieces: BlobPart[] = [];
	let closed = false;
	const stageWriter = {
		write: vi.fn(async (chunk: Uint8Array) => {
			pieces.push(chunk.slice().buffer);
		}),
		close: vi.fn(async () => {
			closed = true;
		}),
		abort: vi.fn(async () => undefined),
	};
	const streamCalls = vi.fn();
	const handle = {
		createWritable: async () => stageWriter,
		getFile: vi.fn(async () => {
			expect(closed).toBe(true);
			const file = new File(pieces, "ciphertext");
			const stream = file.stream.bind(file);
			file.stream = () => {
				streamCalls(file);
				return stream();
			};
			return file;
		}),
	} as unknown as FileSystemFileHandle;
	const cleanup = vi.fn();
	async function withStage<T>(
		use: (handle: FileSystemFileHandle) => Promise<T>,
	): Promise<T> {
		try {
			return await use(handle);
		} finally {
			cleanup();
		}
	}
	return { withStage, stageWriter, handle, cleanup, pieces, streamCalls };
}

function fileDestination() {
	const pieces: Uint8Array[] = [];
	const writer = {
		write: vi.fn(async (chunk: Uint8Array) => {
			pieces.push(chunk.slice());
		}),
		close: vi.fn(async () => undefined),
		abort: vi.fn(async () => undefined),
	};
	const destination = {
		createWritable: vi.fn(
			async () => writer as unknown as FileSystemWritableFileStream,
		),
	};
	return { destination, writer, pieces };
}

describe("bounded attachment downloads", () => {
	test("rejects a known oversized response before reading or creating a blob URL", async () => {
		const { row, wdk } = await fixture();
		const cancel = vi.fn();
		const createObjectURL = vi.fn();
		await expect(
			downloadAttachment(row, wdk, {
				fetcher: async () =>
					new Response(new ReadableStream({ cancel }), {
						headers: { "content-length": String(MEMORY_DOWNLOAD_BYTES + 1) },
					}),
				urls: { createObjectURL, revokeObjectURL: vi.fn() },
			}),
		).rejects.toBeInstanceOf(DownloadMemoryLimitError);
		expect(cancel).toHaveBeenCalledOnce();
		expect(createObjectURL).not.toHaveBeenCalled();
	});

	test("enforces the plaintext limit even when the server omits the length", async () => {
		const { row, wdk, dek } = await fixture();
		async function* large() {
			const chunk = new Uint8Array(1024 * 1024);
			for (let i = 0; i < 65; i++) yield chunk;
		}
		const encrypted = encryptStream(large(), dek, "content")[
			Symbol.asyncIterator
		]();
		const cancel = vi.fn(async () => {
			await encrypted.return?.();
		});
		const body = new ReadableStream<Uint8Array>({
			async pull(controller) {
				const next = await encrypted.next();
				if (next.done) controller.close();
				else controller.enqueue(next.value);
			},
			cancel,
		});
		const createObjectURL = vi.fn();
		await expect(
			downloadAttachment(row, wdk, {
				fetcher: async () => new Response(body),
				urls: { createObjectURL, revokeObjectURL: vi.fn() },
			}),
		).rejects.toBeInstanceOf(DownloadMemoryLimitError);
		expect(createObjectURL).not.toHaveBeenCalled();
	});

	test("stages ciphertext and saves verified content in bounded chunks", async () => {
		const { row, wdk, dek } = await fixture();
		const plaintext = new Uint8Array(2 * 1024 * 1024 + 17).fill(42);
		const ciphertext = await collect(
			encryptStream(source(plaintext), dek, "content"),
		);
		const stage = fileStage();
		const output = fileDestination();
		await saveAttachmentToFile(row, wdk, output.destination, {
			fetcher: async () => response(ciphertext),
			withStage: stage.withStage,
		});
		expect(
			Buffer.compare(
				Buffer.from(await new Blob(stage.pieces).arrayBuffer()),
				Buffer.from(ciphertext),
			),
		).toBe(0);
		expect(output.pieces.map((chunk) => chunk.length)).toEqual([
			1024 * 1024,
			1024 * 1024,
			17,
		]);
		expect(
			Buffer.compare(Buffer.concat(output.pieces), Buffer.from(plaintext)),
		).toBe(0);
		expect(output.writer.close).toHaveBeenCalledOnce();
		expect(output.writer.abort).not.toHaveBeenCalled();
		expect(stage.handle.getFile).toHaveBeenCalledOnce();
		expect(stage.streamCalls).toHaveBeenCalledTimes(2);
		expect(stage.streamCalls.mock.calls[0][0]).toBe(
			stage.streamCalls.mock.calls[1][0],
		);
		expect(stage.cleanup).toHaveBeenCalledOnce();
	});

	test.each([
		"tampered",
		"truncated",
	])("never opens the destination when the final ciphertext segment is %s", async (failure) => {
		const { row, wdk, dek } = await fixture();
		const ciphertext = await collect(
			encryptStream(source(new Uint8Array(2500)), dek, "content", 1024),
		);
		if (failure === "tampered") ciphertext[ciphertext.length - 1] ^= 1;
		const invalid =
			failure === "truncated" ? ciphertext.slice(0, -100) : ciphertext;
		const stage = fileStage();
		const output = fileDestination();
		await expect(
			saveAttachmentToFile(row, wdk, output.destination, {
				fetcher: async () => response(invalid),
				withStage: stage.withStage,
			}),
		).rejects.toThrow();
		expect(output.destination.createWritable).not.toHaveBeenCalled();
		expect(output.writer.write).not.toHaveBeenCalled();
		expect(stage.cleanup).toHaveBeenCalledOnce();
	});

	test("aborts a failed destination write and cleans the ciphertext stage", async () => {
		const { row, wdk, dek } = await fixture();
		const ciphertext = await collect(
			encryptStream(source(new Uint8Array(2500)), dek, "content", 1024),
		);
		const stage = fileStage();
		const output = fileDestination();
		output.writer.write.mockRejectedValueOnce(new Error("disk full"));
		await expect(
			saveAttachmentToFile(row, wdk, output.destination, {
				fetcher: async () => response(ciphertext),
				withStage: stage.withStage,
			}),
		).rejects.toThrow("disk full");
		expect(output.writer.abort).toHaveBeenCalledOnce();
		expect(output.writer.close).not.toHaveBeenCalled();
		expect(stage.cleanup).toHaveBeenCalledOnce();
	});
});

test.each([
	"transfer",
	"verification",
	"saving",
])("cancels a file download during %s without committing plaintext", async (phase) => {
	const { row, wdk, dek } = await fixture();
	const ciphertext = await collect(
		encryptStream(source(new Uint8Array(2500)), dek, "content", 1024),
	);
	const stage = fileStage();
	const output = fileDestination();
	const controller = new AbortController();
	if (phase === "verification")
		stage.streamCalls.mockImplementationOnce(() => controller.abort());
	if (phase === "saving")
		output.writer.write.mockImplementationOnce(async () => {
			controller.abort();
		});
	await expect(
		saveAttachmentToFile(row, wdk, output.destination, {
			fetcher: async () => response(ciphertext),
			withStage: stage.withStage,
			signal: controller.signal,
			onProgress: (progress) => {
				if (phase === "transfer" && progress.phase === "transferring")
					controller.abort();
			},
		}),
	).rejects.toThrow();
	expect(output.writer.close).not.toHaveBeenCalled();
	if (phase === "saving") expect(output.writer.abort).toHaveBeenCalledOnce();
	else expect(output.destination.createWritable).not.toHaveBeenCalled();
	if (phase === "transfer")
		expect(stage.stageWriter.abort).toHaveBeenCalledOnce();
	expect(stage.cleanup).toHaveBeenCalledOnce();
});
