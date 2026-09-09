import { describe, expect, test, vi } from "vitest";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { encryptStream } from "../../../domain/e2e/stream.ts";
import { encodeWrapped } from "../../../domain/e2e/wire.ts";
import {
	downloadAttachment,
	downloadAttachmentThumbnail,
	type PlaintextSink,
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
