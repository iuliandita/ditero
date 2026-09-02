import { describe, expect, test, vi } from "vitest";
import { aad, decryptWrapped } from "../../../domain/e2e/envelope.ts";
import { decryptStream } from "../../../domain/e2e/stream.ts";
import { decodeWrapped } from "../../../domain/e2e/wire.ts";
import { AttachmentUploadError, uploadAttachment } from "./upload.ts";

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

async function requestBytes(body: BodyInit | null | undefined) {
	if (!(body instanceof ReadableStream))
		throw new Error("expected stream body");
	const reader = body.getReader();
	return await collect(
		(async function* () {
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) return;
					yield next.value;
				}
			} finally {
				reader.releaseLock();
			}
		})(),
	);
}

describe("uploadAttachment", () => {
	test("encrypts metadata, content, and a re-encoded thumbnail before finalize", async () => {
		const wdk = crypto.getRandomValues(new Uint8Array(32));
		const plaintext = new TextEncoder().encode("private file contents");
		const thumbnailPlaintext = new TextEncoder().encode("decoded png pixels");
		const file = new File([plaintext], "../secret\u202E.txt.png", {
			type: "image/png",
		});
		let reservation: Record<string, unknown> | undefined;
		let encryptedContent: Uint8Array | undefined;
		let encryptedThumbnail: Uint8Array | undefined;
		const paths: string[] = [];
		const progress: number[] = [];
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				paths.push(path);
				if (path === "/api/attachments/reserve") {
					reservation = JSON.parse(String(init?.body));
					return Response.json({
						id: "attachment-1",
						uploadUrl: "/api/attachments/attachment-1/upload",
						thumbnailUploadUrl: "/api/attachments/attachment-1/thumbnail",
					});
				}
				if (path.endsWith("/upload")) {
					encryptedContent = await requestBytes(init?.body);
					return Response.json({ state: "uploading" });
				}
				if (path.endsWith("/thumbnail")) {
					encryptedThumbnail = await requestBytes(init?.body);
					return Response.json({ state: "uploading" });
				}
				if (path === "/api/attachments/finalize") {
					return Response.json({ id: "attachment-1", state: "committed" });
				}
				throw new Error(`unexpected request ${path}`);
			},
		);

		const result = await uploadAttachment(
			{
				file,
				workspaceId: "workspace-1",
				parentKind: "task",
				parentId: "task-1",
				keyVersion: 3,
				wdk,
			},
			{
				id: "attachment-1",
				fetcher,
				thumbnailer: async () =>
					new Blob([thumbnailPlaintext], { type: "image/png" }),
				onProgress: (event) => {
					if (event.phase === "uploading") progress.push(event.loaded);
				},
			},
		);

		expect(result).toEqual({ id: "attachment-1", state: "committed" });
		expect(paths).toEqual([
			"/api/attachments/reserve",
			"/api/attachments/attachment-1/upload",
			"/api/attachments/attachment-1/thumbnail",
			"/api/attachments/finalize",
		]);
		expect(reservation).toBeDefined();
		const dek = await decryptWrapped(
			decodeWrapped(String(reservation?.dekWrapped)),
			wdk,
			aad.dek("workspace-1", 3, "attachment-1"),
		);
		expect(
			new TextDecoder().decode(
				await decryptWrapped(
					decodeWrapped(String(reservation?.filenameCiphertext)),
					dek,
					aad.metadata("attachment-1", "filename"),
				),
			),
		).toBe("secret.txt.png");
		expect(
			new TextDecoder().decode(
				await decryptWrapped(
					decodeWrapped(String(reservation?.contentTypeCiphertext)),
					dek,
					aad.metadata("attachment-1", "contentType"),
				),
			),
		).toBe("image/png");
		expect(
			await collect(
				decryptStream(
					source(encryptedContent ?? new Uint8Array()),
					dek,
					"content",
				),
			),
		).toEqual(plaintext);
		expect(
			await collect(
				decryptStream(
					source(encryptedThumbnail ?? new Uint8Array()),
					dek,
					"thumbnail",
				),
			),
		).toEqual(thumbnailPlaintext);
		expect(reservation?.declaredBytes).toBe(encryptedContent?.length);
		expect(reservation?.thumbnailDeclaredBytes).toBe(
			encryptedThumbnail?.length,
		);
		expect(progress).toEqual([...progress].sort((a, b) => a - b));
		expect(progress.at(-1)).toBe(
			Number(reservation?.declaredBytes) +
				Number(reservation?.thumbnailDeclaredBytes),
		);
	});

	test("does not create or declare a thumbnail for a non-previewable format", async () => {
		const thumbnailer = vi.fn();
		let reservation: Record<string, unknown> | undefined;
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				if (path === "/api/attachments/reserve") {
					reservation = JSON.parse(String(init?.body));
					return Response.json({
						id: "attachment-html",
						uploadUrl: "/api/attachments/attachment-html/upload",
						thumbnailUploadUrl: null,
					});
				}
				if (path.endsWith("/upload")) {
					await requestBytes(init?.body);
					return Response.json({ state: "uploading" });
				}
				return Response.json({ id: "attachment-html", state: "committed" });
			},
		);

		await uploadAttachment(
			{
				file: new File(["<script>"], "page.html", { type: "text/html" }),
				workspaceId: "workspace-1",
				parentKind: "list",
				parentId: "list-1",
				keyVersion: 1,
				wdk: crypto.getRandomValues(new Uint8Array(32)),
			},
			{ id: "attachment-html", fetcher, thumbnailer },
		);

		expect(thumbnailer).not.toHaveBeenCalled();
		expect(reservation?.thumbnailDeclaredBytes).toBeNull();
	});

	test("uses a fresh request to abort when streaming fails", async () => {
		const controller = new AbortController();
		const calls: Array<{
			path: string;
			signal: AbortSignal | null | undefined;
		}> = [];
		const fetcher = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const path = String(input);
				calls.push({ path, signal: init?.signal });
				if (path === "/api/attachments/reserve") {
					return Response.json({
						id: "attachment-fail",
						uploadUrl: "/api/attachments/attachment-fail/upload",
						thumbnailUploadUrl: null,
					});
				}
				if (path.endsWith("/upload")) {
					controller.abort();
					throw new DOMException("cancelled", "AbortError");
				}
				if (path === "/api/attachments/abort")
					return Response.json({ state: "aborted" });
				throw new Error(`unexpected request ${path}`);
			},
		);

		await expect(
			uploadAttachment(
				{
					file: new File(["private"], "private.txt", { type: "text/plain" }),
					workspaceId: "workspace-1",
					parentKind: "comment",
					parentId: "comment-1",
					keyVersion: 1,
					wdk: crypto.getRandomValues(new Uint8Array(32)),
				},
				{ id: "attachment-fail", fetcher, signal: controller.signal },
			),
		).rejects.toThrow();
		expect(calls.at(-1)).toEqual({
			path: "/api/attachments/abort",
			signal: undefined,
		});
	});

	test("attempts abort when reserve succeeds but its response is lost", async () => {
		const paths: string[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const path = String(input);
			paths.push(path);
			if (path === "/api/attachments/reserve")
				throw new TypeError("connection reset");
			return Response.json({ state: "aborted" });
		});

		await expect(
			uploadAttachment(
				{
					file: new File(["private"], "private.txt", { type: "text/plain" }),
					workspaceId: "workspace-1",
					parentKind: "task",
					parentId: "task-1",
					keyVersion: 1,
					wdk: crypto.getRandomValues(new Uint8Array(32)),
				},
				{ id: "attachment-lost", fetcher },
			),
		).rejects.toThrow("connection reset");
		expect(paths).toEqual([
			"/api/attachments/reserve",
			"/api/attachments/abort",
		]);
	});

	test.each([
		[413, "file-too-large"],
		[409, "quota-exceeded"],
		[409, "rotation-required"],
		[409, "key-unavailable"],
	] as const)("preserves a %s reserve failure as %s", async (status, reason) => {
		const fetcher = vi.fn(async (input: RequestInfo | URL) =>
			String(input) === "/api/attachments/reserve"
				? new Response(reason, { status })
				: Response.json({ state: "aborted" }),
		);
		const failure = await uploadAttachment(
			{
				file: new File(["private"], "private.txt", {
					type: "text/plain",
				}),
				workspaceId: "workspace-1",
				parentKind: "task",
				parentId: "task-1",
				keyVersion: 1,
				wdk: crypto.getRandomValues(new Uint8Array(32)),
			},
			{ id: `attachment-${reason}`, fetcher },
		).catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(AttachmentUploadError);
		expect(failure).toMatchObject({ stage: "reserve", reason, status });
	});
});
