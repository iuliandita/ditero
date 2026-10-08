import { afterEach, describe, expect, test, vi } from "vitest";
import { aad, decryptWrapped } from "../../../domain/e2e/envelope.ts";
import { decryptStream } from "../../../domain/e2e/stream.ts";
import { decodeWrapped } from "../../../domain/e2e/wire.ts";
import {
	AttachmentUploadCapabilityError,
	AttachmentUploadError,
	BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES,
	getAttachmentUploadCapability,
	uploadAttachment,
} from "./upload.ts";

afterEach(() => vi.unstubAllGlobals());

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

test("OPFS stores only ciphertext and removes the stage after uploading", async () => {
	const chunks: Uint8Array[] = [];
	const files = new Set<string>();
	let reservation: Record<string, unknown> = {};
	let sent: File | undefined;
	const wdk = crypto.getRandomValues(new Uint8Array(32));
	const plaintext = new TextEncoder().encode("private staged contents");
	const writable = {
		write: async (chunk: Uint8Array) => {
			chunks.push(chunk);
		},
		close: async () => {},
		abort: async () => {},
	};
	const root = {
		async *entries() {},
		async getFileHandle(name: string) {
			files.add(name);
			return {
				createWritable: async () => writable,
				getFile: async () =>
					new File(
						chunks.map((chunk) => chunk.slice()),
						name,
					),
			};
		},
		async removeEntry(name: string) {
			files.delete(name);
		},
	};
	vi.stubGlobal(
		"FileSystemFileHandle",
		class {
			createWritable() {}
		},
	);
	vi.stubGlobal("navigator", {
		storage: { getDirectory: async () => root },
		locks: {
			request: async (_name: string, use: () => Promise<unknown>) =>
				await use(),
		},
	});
	vi.stubGlobal(
		"XMLHttpRequest",
		class {
			upload = {};
			status = 200;
			statusText = "OK";
			responseText = "";
			onload?: () => void;
			open() {}
			setRequestHeader() {}
			send(file: File) {
				sent = file;
				this.onload?.();
			}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input) === "/api/attachments/reserve") {
				reservation = JSON.parse(String(init?.body));
				return Response.json({
					id: "staged",
					uploadUrl: "/api/attachments/staged/upload",
					thumbnailUploadUrl: null,
				});
			}
			return Response.json({ id: "staged", state: "committed" });
		}),
	);
	await uploadAttachment(
		{
			file: new File([plaintext], "secret.txt", { type: "text/plain" }),
			workspaceId: "workspace-1",
			parentKind: "task",
			parentId: "task-1",
			keyVersion: 1,
			wdk,
		},
		{ id: "staged" },
	);
	expect(files.size).toBe(0);
	expect(sent).toBeDefined();
	const ciphertext = new Uint8Array(await (sent as File).arrayBuffer());
	expect(ciphertext).not.toEqual(plaintext);
	const dek = await decryptWrapped(
		decodeWrapped(String(reservation.dekWrapped)),
		wdk,
		aad.dek("workspace-1", 1, "staged"),
	);
	expect(
		await collect(decryptStream(source(ciphertext), dek, "content")),
	).toEqual(plaintext);
});

type TestXhr = {
	body?: Blob;
	url: string;
	withCredentials: boolean;
	headers: Record<string, string>;
	status: number;
	responseText: string;
	upload: { onprogress?: (event: { loaded: number }) => void };
	onload?: () => void;
	onerror?: () => void;
	onabort?: () => void;
	complete: () => void;
};

function browserFixture(send?: (request: TestXhr) => void) {
	const requests: TestXhr[] = [];
	const calls: Array<{ path: string; signal?: AbortSignal | null }> = [];
	const reservations = new Map<string, Record<string, unknown>>();
	vi.stubGlobal("navigator", { storage: {}, locks: { request: vi.fn() } });
	vi.stubGlobal(
		"XMLHttpRequest",
		class implements TestXhr {
			body?: Blob;
			url = "";
			withCredentials = false;
			headers: Record<string, string> = {};
			status = 200;
			statusText = "OK";
			responseText = "";
			upload: TestXhr["upload"] = {};
			onload?: () => void;
			onerror?: () => void;
			onabort?: () => void;
			open(_method: string, url: string) {
				this.url = url;
			}
			setRequestHeader(name: string, value: string) {
				this.headers[name] = value;
			}
			abort() {
				this.onabort?.();
			}
			complete() {
				this.onload?.();
			}
			send(body: Blob) {
				this.body = body;
				requests.push(this);
				if (send) send(this);
				else this.complete();
			}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const path = String(input);
			calls.push({ path, signal: init?.signal });
			expect(init?.body).not.toBeInstanceOf(ReadableStream);
			const body = JSON.parse(String(init?.body));
			if (path.endsWith("/reserve")) {
				reservations.set(body.id, body);
				return Response.json({
					id: body.id,
					uploadUrl: `/api/attachments/${body.id}/upload`,
					thumbnailUploadUrl:
						body.thumbnailDeclaredBytes === null
							? null
							: `/api/attachments/${body.id}/thumbnail`,
				});
			}
			return Response.json({
				id: body.id,
				state: path.endsWith("/abort") ? "aborted" : "committed",
			});
		}),
	);
	return { requests, calls, reservations };
}

function uploadInput(
	file = new File(["private"], "private.txt", { type: "text/plain" }),
) {
	return {
		file,
		workspaceId: "workspace-1",
		parentKind: "task" as const,
		parentId: "task-1",
		keyVersion: 1,
		wdk: crypto.getRandomValues(new Uint8Array(32)),
	};
}

test("selects callable browser capabilities and preserves supplied stream transports", () => {
	browserFixture();
	expect(getAttachmentUploadCapability()).toBe("bounded-blob");
	vi.stubGlobal("navigator", {
		locks: { request() {} },
		storage: { getDirectory() {} },
	});
	vi.stubGlobal("FileSystemFileHandle", class {});
	expect(getAttachmentUploadCapability()).toBe("bounded-blob");
	vi.stubGlobal(
		"FileSystemFileHandle",
		class {
			createWritable() {}
		},
	);
	expect(getAttachmentUploadCapability()).toBe("private-file");
	vi.stubGlobal("XMLHttpRequest", undefined);
	expect(getAttachmentUploadCapability()).toBe("unavailable");
	expect(getAttachmentUploadCapability(async () => new Response())).toBe(
		"stream",
	);
});

test("bounded Blob uploads decryptable content and thumbnail with network-only monotonic progress", async () => {
	const fixture = browserFixture((request) => {
		request.upload.onprogress?.({ loaded: 4 });
		request.upload.onprogress?.({ loaded: 2 });
		request.upload.onprogress?.({ loaded: 999999 });
		request.complete();
	});
	const input = uploadInput(
		new File(["private content"], "private.png", { type: "image/png" }),
	);
	const progress: Array<{ phase: string; loaded: number }> = [];
	await uploadAttachment(input, {
		id: "blob",
		thumbnailer: async () => new Blob(["private thumbnail"]),
		onProgress: (event) => progress.push(event),
	});
	const reservation = fixture.reservations.get("blob");
	const dek = await decryptWrapped(
		decodeWrapped(String(reservation?.dekWrapped)),
		input.wdk,
		aad.dek(input.workspaceId, input.keyVersion, "blob"),
	);
	expect(fixture.requests).toHaveLength(2);
	for (const [index, request] of fixture.requests.entries()) {
		expect(request.body).toBeInstanceOf(Blob);
		expect(request.withCredentials).toBe(true);
		expect(request.headers["content-type"]).toBe("application/octet-stream");
		if (!request.body) throw new Error("missing ciphertext body");
		const ciphertext = new Uint8Array(await request.body.arrayBuffer());
		const plaintext = await collect(
			decryptStream(
				source(ciphertext),
				dek,
				index === 0 ? "content" : "thumbnail",
			),
		);
		expect(new TextDecoder().decode(plaintext)).toBe(
			index === 0 ? "private content" : "private thumbnail",
		);
		expect(ciphertext.byteLength).toBe(
			index === 0
				? reservation?.declaredBytes
				: reservation?.thumbnailDeclaredBytes,
		);
	}
	const loaded = progress.map((event) => event.loaded);
	expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
	expect(
		progress
			.filter((event) => event.phase === "encrypting")
			.map((event) => event.loaded),
	).toEqual([
		0,
		0,
		0,
		fixture.requests[0]?.body?.size,
		fixture.requests[0]?.body?.size,
	]);
	expect(fixture.calls.map((call) => call.path)).toEqual([
		"/api/attachments/reserve",
		"/api/attachments/finalize",
	]);
});

test.each([
	false,
	true,
])("refuses oversized combined ciphertext before metadata, reserve, or source read (thumbnail %s)", async (thumbnail) => {
	const fixture = browserFixture();
	const file = new File(["small"], thumbnail ? "image.png" : "file.txt", {
		type: thumbnail ? "image/png" : "text/plain",
	});
	const stream = vi.spyOn(file, "stream");
	if (!thumbnail)
		Object.defineProperty(file, "size", {
			value: BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES,
		});
	const encrypted = vi.spyOn(crypto.subtle, "encrypt");
	await expect(
		uploadAttachment(uploadInput(file), {
			thumbnailer: async () => {
				const blob = new Blob(["small"]);
				Object.defineProperty(blob, "size", {
					value: BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES,
				});
				return blob;
			},
		}),
	).rejects.toMatchObject({
		name: "AttachmentUploadCapabilityError",
		reason: "bounded-ciphertext-limit",
		limitBytes: BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES,
	});
	expect(stream).not.toHaveBeenCalled();
	expect(encrypted).not.toHaveBeenCalled();
	encrypted.mockRestore();
	expect(fixture.calls).toEqual([]);
});

test("unavailable transport is typed and never reserves", async () => {
	const fixture = browserFixture();
	vi.stubGlobal("XMLHttpRequest", undefined);
	await expect(uploadAttachment(uploadInput())).rejects.toBeInstanceOf(
		AttachmentUploadCapabilityError,
	);
	expect(fixture.calls).toEqual([]);
});

test("already canceled Blob upload never reserves or sends", async () => {
	const fixture = browserFixture();
	const controller = new AbortController();
	controller.abort();
	await expect(
		uploadAttachment(uploadInput(), { signal: controller.signal }),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(fixture.calls).toEqual([]);
	expect(fixture.requests).toEqual([]);
});

test.each([
	"cancel",
	"network",
	"http",
	"progress",
] as const)("Blob %s failure aborts freshly and never finalizes", async (failure) => {
	const controller = new AbortController();
	const fixture = browserFixture((request) => {
		if (failure === "cancel") controller.abort();
		else if (failure === "network") request.onerror?.();
		else if (failure === "http") {
			request.status = 409;
			request.responseText = "quota-exceeded";
			request.complete();
		} else request.upload.onprogress?.({ loaded: 1 });
	});
	await expect(
		uploadAttachment(uploadInput(), {
			signal: controller.signal,
			onProgress: (event) => {
				if (failure === "progress" && event.phase === "uploading")
					throw new Error("callback failed");
			},
		}),
	).rejects.toBeInstanceOf(Error);
	expect(fixture.calls.map((call) => call.path)).toEqual([
		"/api/attachments/reserve",
		"/api/attachments/abort",
	]);
	expect(fixture.calls.at(-1)?.signal).toBeUndefined();
});

test("encryption source failure closes reader and aborts reservation without sending", async () => {
	const fixture = browserFixture();
	const file = new File(["secret"], "private.txt");
	const cancel = vi.fn();
	vi.spyOn(file, "stream").mockReturnValue(
		new ReadableStream({
			pull() {
				throw new Error("source failed");
			},
			cancel,
		}),
	);
	await expect(uploadAttachment(uploadInput(file))).rejects.toThrow(
		"source failed",
	);
	expect(fixture.requests).toHaveLength(0);
	expect(fixture.calls.map((call) => call.path)).toEqual([
		"/api/attachments/reserve",
		"/api/attachments/abort",
	]);
});

test("cancel during ciphertext collection cancels source and sends no body", async () => {
	const fixture = browserFixture();
	const controller = new AbortController();
	const file = new File(["secret"], "private.txt");
	const cancel = vi.fn();
	vi.spyOn(file, "stream").mockReturnValue(
		new ReadableStream(
			{
				pull() {
					controller.abort();
				},
				cancel,
			},
			{ highWaterMark: 0 },
		),
	);
	await expect(
		uploadAttachment(uploadInput(file), { signal: controller.signal }),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(cancel).toHaveBeenCalled();
	expect(fixture.requests).toHaveLength(0);
	expect(fixture.calls.at(-1)?.path).toBe("/api/attachments/abort");
});

test("one Blob upload owns the permit and canceled waiters do not reserve", async () => {
	const fixture = browserFixture(() => {});
	const first = uploadAttachment(uploadInput(), { id: "first" });
	await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
	const controller = new AbortController();
	const second = uploadAttachment(uploadInput(), {
		id: "second",
		signal: controller.signal,
	});
	const third = uploadAttachment(uploadInput(), { id: "third" });
	controller.abort();
	await expect(second).rejects.toMatchObject({ name: "AbortError" });
	expect(
		fixture.calls.filter((call) => call.path.endsWith("/reserve")),
	).toHaveLength(1);
	fixture.requests[0]?.complete();
	await first;
	await vi.waitFor(() => expect(fixture.requests).toHaveLength(2));
	fixture.requests[1]?.complete();
	await third;
	expect([...fixture.reservations.keys()]).toEqual(["first", "third"]);
});

test("bounded ciphertext accepts its exact combined limit", async () => {
	const fixture = browserFixture();
	const plaintextLength = BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES - 33 - 8 * 16;
	await uploadAttachment(
		uploadInput(new File([new Uint8Array(plaintextLength)], "limit.txt")),
	);
	expect(fixture.requests[0]?.body?.size).toBe(
		BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES,
	);
});

test("observed ciphertext length mismatch aborts before XHR send", async () => {
	const fixture = browserFixture();
	const file = new File(["longer than declared"], "mismatch.txt");
	Object.defineProperty(file, "size", { value: 1 });
	await expect(uploadAttachment(uploadInput(file))).rejects.toBeInstanceOf(
		Error,
	);
	expect(fixture.requests).toHaveLength(0);
	expect(fixture.calls.at(-1)?.path).toBe("/api/attachments/abort");
});

test("cancel after encryption progress settles before XHR send and releases permit", async () => {
	const fixture = browserFixture();
	const controller = new AbortController();
	await expect(
		uploadAttachment(uploadInput(), {
			signal: controller.signal,
			onProgress: (event) => {
				if (event.phase === "encrypting" && fixture.calls.length > 0)
					controller.abort();
			},
		}),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(fixture.requests).toHaveLength(0);
	await uploadAttachment(uploadInput());
	expect(fixture.requests).toHaveLength(1);
});

test("Blob finalize failure keeps fresh abort behavior", async () => {
	const fixture = browserFixture();
	const previous = fetch;
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/finalize"))
				return new Response("refused", { status: 409 });
			return previous(input, init);
		},
	);
	await expect(uploadAttachment(uploadInput())).rejects.toMatchObject({
		stage: "finalizing",
		status: 409,
	});
	expect(fixture.calls.at(-1)?.path).toBe("/api/attachments/abort");
});

test("oversized browser content refuses before thumbnail decoding", async () => {
	browserFixture();
	const file = new File(["small"], "large.png", { type: "image/png" });
	Object.defineProperty(file, "size", {
		value: BROWSER_CIPHERTEXT_UPLOAD_LIMIT_BYTES,
	});
	const thumbnailer = vi.fn();
	await expect(
		uploadAttachment(uploadInput(file), { thumbnailer }),
	).rejects.toMatchObject({ reason: "bounded-ciphertext-limit" });
	expect(thumbnailer).not.toHaveBeenCalled();
});

test("captures transport selection across thumbnail preparation", async () => {
	const fixture = browserFixture();
	await uploadAttachment(
		uploadInput(new File(["private"], "private.png", { type: "image/png" })),
		{
			thumbnailer: async () => {
				vi.stubGlobal(
					"FileSystemFileHandle",
					class {
						createWritable() {}
					},
				);
				vi.stubGlobal("navigator", {
					storage: {
						getDirectory: vi.fn(() => {
							throw new Error("selection drift");
						}),
					},
					locks: { request() {} },
				});
				return null;
			},
		},
	);
	expect(fixture.requests).toHaveLength(1);
});

test("XHR cancellation before send settles even when abort emits no event", async () => {
	const fixture = browserFixture();
	const controller = new AbortController();
	const send = vi.fn();
	vi.stubGlobal(
		"XMLHttpRequest",
		class {
			upload = {};
			open() {
				controller.abort();
			}
			setRequestHeader() {}
			abort() {}
			send = send;
		},
	);
	await expect(
		uploadAttachment(uploadInput(), { signal: controller.signal }),
	).rejects.toMatchObject({ name: "AbortError" });
	expect(send).not.toHaveBeenCalled();
	expect(fixture.calls.at(-1)?.path).toBe("/api/attachments/abort");
});

test("failed Blob upload releases permit before stalled reservation cleanup", async () => {
	const fixture = browserFixture((request) => {
		if (request.url.includes("failed")) request.onerror?.();
		else request.complete();
	});
	let resolveAbort: (() => void) | undefined;
	const abortStarted = new Promise<void>((resolve) => {
		resolveAbort = resolve;
	});
	let finishAbort: ((response: Response) => void) | undefined;
	const stalledAbort = new Promise<Response>((resolve) => {
		finishAbort = resolve;
	});
	const originalFetch = fetch;
	vi.stubGlobal(
		"fetch",
		async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).endsWith("/abort")) {
				expect(init?.signal).toBeUndefined();
				resolveAbort?.();
				return stalledAbort;
			}
			return originalFetch(input, init);
		},
	);
	const failed = uploadAttachment(uploadInput(), { id: "failed" }).catch(
		(error: unknown) => error,
	);
	await abortStarted;
	try {
		await expect(
			uploadAttachment(uploadInput(), { id: "next" }),
		).resolves.toEqual({ id: "next", state: "committed" });
		expect(fixture.requests).toHaveLength(2);
	} finally {
		finishAbort?.(Response.json({ state: "aborted" }));
	}
	await expect(failed).resolves.toBeInstanceOf(TypeError);
});
