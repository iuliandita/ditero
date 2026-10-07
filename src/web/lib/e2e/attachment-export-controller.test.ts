import { afterEach, describe, expect, it, vi } from "vitest";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { encryptStream, StreamError } from "../../../domain/e2e/stream.ts";
import { encodeWrapped } from "../../../domain/e2e/wire.ts";
import type { PortableExportV1 } from "../../../domain/portability/v1.ts";
import { registerZeroClient } from "../zero-lifecycle.ts";
import { openAttachmentArchive } from "./attachment-archive.ts";
import { createAttachmentExportController } from "./attachment-export-controller.ts";
import type { KeyringContextValue } from "./KeyringProvider.tsx";
import { browserE2eRuntime } from "./runtime.ts";

const cleanup: (() => Promise<void>)[] = [];
const hash = "a".repeat(64);
function documentValue(): PortableExportV1 {
	return {
		format: "ditero",
		schemaVersion: 1,
		exportedAt: "2026-10-05T00:00:00.000Z",
		sourceUserId: "source-user",
		boundaries: {
			attachmentContent: "excluded",
			encryptionKeys: "excluded",
			credentials: "excluded",
			managedAccounts: "excluded",
			restoreSupported: false,
			taskHistory: "current-state-and-habit-logs",
		},
		data: {
			attachments: [
				{
					id: "source-file",
					workspaceId: "source-workspace",
					parentKind: "task",
					parentId: "source-task",
					keyVersion: 1,
					declaredBytes: 50,
					observedBytes: 50,
					ciphertextSha256: hash,
					thumbnailDeclaredBytes: null,
					thumbnailObservedBytes: null,
					thumbnailCiphertextSha256: null,
					uploadedBy: "original-uploader",
					createdAt: "2026-10-05T00:00:00.000Z",
					committedAt: "2026-10-05T00:00:00.000Z",
				},
			],
			principals: [],
			workspaces: [],
			memberships: [],
			folders: [],
			lists: [],
			tasks: [],
			labels: [],
			taskLabels: [],
			templates: [],
			assignments: [],
			comments: [],
			habitLogs: [],
			views: [],
			dashboards: [],
			userPrefs: [],
			focusSessions: [],
			karma: [],
			karmaEvents: [],
		},
	};
}

const wrap = (bytes: number) =>
	encodeWrapped({
		version: 1,
		nonce: new Uint8Array(12),
		ciphertext: new Uint8Array(bytes + 16),
	});
const source = () => ({
	id: "source-file",
	workspaceId: "source-workspace",
	parentKind: "task" as const,
	parentId: "source-task",
	keyVersion: 1,
	filenameCiphertext: wrap(8),
	contentTypeCiphertext: wrap(10),
	dekWrapped: wrap(32),
});
function controller(userID = "source-user", registered = true) {
	const zero = {
		userID,
		mutate: () => ({ client: Promise.resolve() }),
		close: async () => {},
	};
	let cancelled = false;
	if (registered)
		cleanup.push(
			registerZeroClient(
				userID,
				zero,
				() => {},
				() => cancelled,
			).retire,
		);
	const keys = {
		runtime: browserE2eRuntime,
		ready: true,
		state: "ready",
	} as unknown as KeyringContextValue;
	const options = {
		ownerId: "source-user",
		zero,
		exactContentDocument: JSON.stringify(documentValue()),
		keyring: () => keys,
	};
	return {
		options,
		retire: () => {
			cancelled = true;
		},
	};
}
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(cleanup.splice(0).map((retire) => retire()));
});
describe("attachment export selection", () => {
	it("accepts the matching registered account and bounded envelopes", () => {
		const { options } = controller();
		expect(
			createAttachmentExportController(options).preflightSelected([source()]),
		).toMatchObject({ count: 1, encryptedBytes: 50 });
	});
	it("refuses native runtimes without explicit archive export capability", () => {
		const c = controller();
		const keys = { ...c.options.keyring(), runtime: { ...browserE2eRuntime } };
		const value = createAttachmentExportController({
			...c.options,
			keyring: () => keys,
		});
		expect(() => value.preflightSelected([source()])).toThrow(
			"native-unavailable",
		);
	});
	it("refuses a replaced runtime even when the account remains active", () => {
		const c = controller();
		let keys = c.options.keyring();
		const value = createAttachmentExportController({
			...c.options,
			keyring: () => keys,
		});
		keys = { ...keys, runtime: { ...browserE2eRuntime } };
		expect(() => value.preflightSelected([source()])).toThrow("stale");
	});
	it("rejects a registered different account even though a matching document was supplied", () => {
		expect(() =>
			createAttachmentExportController(controller("different-user").options),
		).toThrow("stale");
	});
	it("rejects an unregistered matching instance", () => {
		expect(() =>
			createAttachmentExportController(
				controller("source-user", false).options,
			),
		).toThrow("stale");
	});
	it("rechecks the captured instance after cancellation", () => {
		const c = controller();
		const value = createAttachmentExportController(c.options);
		c.retire();
		expect(() => value.preflightSelected([source()])).toThrow("stale");
	});
	it.each([
		null,
		42,
		"x".repeat(65537),
	])("rejects primitive/length envelope violations before stringify", (filenameCiphertext) => {
		const value = createAttachmentExportController(controller().options);
		const stringify = vi.spyOn(JSON, "stringify");
		expect(() =>
			value.preflightSelected([
				{ ...source(), filenameCiphertext } as unknown as ReturnType<
					typeof source
				>,
			]),
		).toThrow("invalid-selection");
		expect(stringify).not.toHaveBeenCalled();
	});
	it("rejects aggregate envelope growth before stringify", () => {
		const value = createAttachmentExportController(controller().options);
		const stringify = vi.spyOn(JSON, "stringify");
		expect(() =>
			value.preflightSelected([
				{ ...source(), filenameCiphertext: wrap(25000) },
			]),
		).toThrow("byte-limit");
		expect(stringify).not.toHaveBeenCalled();
	});
	it("rejects a supported wrap with the wrong DEK length before stringify", () => {
		const value = createAttachmentExportController(controller().options);
		const stringify = vi.spyOn(JSON, "stringify");
		expect(() =>
			value.preflightSelected([{ ...source(), dekWrapped: wrap(31) }]),
		).toThrow("invalid-selection");
		expect(stringify).not.toHaveBeenCalled();
	});
	it("does not serialize caller toJSON or unknown fields", () => {
		const value = createAttachmentExportController(controller().options);
		const toJSON = vi.fn(() => {
			throw new Error("hostile serializer");
		});
		const hostileSource = { ...source(), toJSON };
		expect(value.preflightSelected([hostileSource])).toMatchObject({
			count: 1,
		});
		expect(toJSON).not.toHaveBeenCalled();
	});
});

async function realCryptoFixture() {
	const c = controller();
	const wdk = new Uint8Array(32).fill(3);
	const dek = new Uint8Array(32).fill(9);
	const kek = new Uint8Array(32).fill(7);
	const text = new TextEncoder();
	async function stream(purpose: "content" | "thumbnail") {
		async function* plaintext() {
			yield text.encode(
				purpose === "content"
					? "a real authenticated source file"
					: "thumbnail plaintext",
			);
		}
		const chunks: Uint8Array[] = [];
		for await (const chunk of encryptStream(plaintext(), dek, purpose, 1024))
			chunks.push(chunk);
		const bytes = new Uint8Array(
			chunks.reduce((size, chunk) => size + chunk.length, 0),
		);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.length;
		}
		return bytes;
	}
	const content = await stream("content");
	const thumbnail = await stream("thumbnail");
	const encryptedSource = {
		...source(),
		filenameCiphertext: encodeWrapped(
			await encryptWrapped(
				text.encode("picnic-notes.txt"),
				dek,
				aad.metadata("source-file", "filename"),
			),
		),
		contentTypeCiphertext: encodeWrapped(
			await encryptWrapped(
				text.encode("text/plain"),
				dek,
				aad.metadata("source-file", "contentType"),
			),
		),
		dekWrapped: encodeWrapped(
			await encryptWrapped(
				dek,
				wdk,
				aad.dek("source-workspace", 1, "source-file"),
			),
		),
	};
	const document = documentValue();
	const row = document.data.attachments[0];
	if (!row) throw new Error("crypto fixture missing row");
	row.declaredBytes = row.observedBytes = content.length;
	row.ciphertextSha256 = await sha256(content);
	row.thumbnailDeclaredBytes = row.thumbnailObservedBytes = thumbnail.length;
	row.thumbnailCiphertextSha256 = await sha256(thumbnail);
	c.options.exactContentDocument = `${JSON.stringify(document, null, 2)}\n`;
	c.options.keyring().workspaceKey = vi.fn(async (workspaceId, keyVersion) => ({
		workspaceId,
		keyVersion: keyVersion ?? 1,
		commitment: "fixture",
		wdk,
	}));
	const derive = vi.fn(async () => kek.slice());
	const dispose = vi.fn();
	const createDeriver = vi.fn(() => ({ derive, dispose }));
	return {
		c,
		wdk,
		content,
		thumbnail,
		encryptedSource,
		document,
		derive,
		dispose,
		createDeriver,
	};
}
async function sha256(bytes: Uint8Array) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)),
		),
		(byte) => byte.toString(16).padStart(2, "0"),
	).join("");
}
function serveCiphertext(
	content: Uint8Array,
	thumbnail: Uint8Array,
	withLength = true,
) {
	return vi
		.spyOn(browserE2eRuntime, "fetcher")
		.mockImplementation(async (input, init) => {
			expect(init?.credentials).toBe("same-origin");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			expect(input).toMatch(
				/^\/api\/attachments\/source-file\/(download|thumbnail)$/,
			);
			const bytes = String(input).endsWith("/thumbnail") ? thumbnail : content;
			return new Response(new Uint8Array(bytes), {
				headers: withLength ? { "content-length": String(bytes.length) } : {},
			});
		});
}
describe("attachment export selection real cryptography", () => {
	it.each([
		true,
		false,
	])("opens authenticated paired artifacts with exact document bytes (Content-Length present: %s)", async (withLength) => {
		const f = await realCryptoFixture();
		const fetcher = serveCiphertext(f.content, f.thumbnail, withLength);
		const value = createAttachmentExportController({
			...f.c.options,
			createDeriver: f.createDeriver,
		});
		await expect(value.describe(f.encryptedSource)).resolves.toEqual({
			id: "source-file",
			filename: "picnic-notes.txt",
		});
		const result = await value.exportSelected(
			[f.encryptedSource],
			"a separate archive passphrase",
		);
		expect(result.content.json).toBe(f.c.options.exactContentDocument);
		expect(result.content.filename).toBe(
			`ditero-content-${result.archiveId}.json`,
		);
		expect(result.files.filename).toBe(`ditero-files-${result.archiveId}.json`);
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			"/api/attachments/source-file/download",
			"/api/attachments/source-file/thumbnail",
		]);
		expect(f.derive).toHaveBeenCalledExactlyOnceWith(
			"a separate archive passphrase",
			expect.any(Uint8Array),
			"passphrase",
			1,
		);
		expect(f.dispose).toHaveBeenCalledTimes(1);
		const opened = await openAttachmentArchive(
			result.files.json,
			result.content.json,
			"a separate archive passphrase",
			{ createDeriver: f.createDeriver },
		);
		expect(opened.manifest.entries[0]?.source).toEqual(f.encryptedSource);
		expect(opened.manifest.entries[0]?.content.bytes).toBe(f.content.length);
		expect(opened.manifest.entries[0]?.thumbnail?.bytes).toBe(
			f.thumbnail.length,
		);
		expect(f.wdk).toEqual(new Uint8Array(32).fill(3));
	});
	it("exports an authenticated native pair through the captured attachment transport", async () => {
		const f = await realCryptoFixture();
		const fallback = vi.fn(async () => {
			throw new Error("generic network refused");
		});
		const nativeFetch = vi.fn(
			async (input: RequestInfo | URL) =>
				new Response(
					new Uint8Array(
						String(input).endsWith("/thumbnail") ? f.thumbnail : f.content,
					),
				),
		);
		const keys = {
			...f.c.options.keyring(),
			runtime: {
				...browserE2eRuntime,
				fetcher: fallback,
				attachments: {
					fetcher: nativeFetch,
					archiveExport: {
						readContent: async () => f.c.options.exactContentDocument,
					},
					pickFile: async () => {
						throw new Error("not saving here");
					},
					withStage: async () => {
						throw new Error("not staging here");
					},
				},
			},
		};
		const value = createAttachmentExportController({
			...f.c.options,
			keyring: () => keys,
			createDeriver: f.createDeriver,
		});
		const pair = await value.exportSelected(
			[f.encryptedSource],
			"archive passphrase",
		);
		expect(pair.content.json).toBe(f.c.options.exactContentDocument);
		const opened = await openAttachmentArchive(
			pair.files.json,
			pair.content.json,
			"archive passphrase",
			{ createDeriver: f.createDeriver },
		);
		expect(opened.manifest.entries[0]?.source).toEqual(f.encryptedSource);
		expect(nativeFetch).toHaveBeenCalledTimes(2);
		expect(fallback).not.toHaveBeenCalled();
	});
	it.each([
		true,
		false,
	])("refuses actual stream tampering before archive KDF (Content-Length present: %s)", async (withLength) => {
		const f = await realCryptoFixture();
		const corrupted = f.content.slice();
		corrupted.set(
			[(corrupted[corrupted.length - 1] ?? 0) ^ 1],
			corrupted.length - 1,
		);
		const row = f.document.data.attachments[0];
		if (!row) throw new Error("missing row");
		row.ciphertextSha256 = await sha256(corrupted);
		f.c.options.exactContentDocument = JSON.stringify(f.document);
		serveCiphertext(corrupted, f.thumbnail, withLength);
		const value = createAttachmentExportController({
			...f.c.options,
			createDeriver: f.createDeriver,
		});
		const operation = value.exportSelected(
			[f.encryptedSource],
			"archive passphrase",
		);
		await expect(operation).rejects.toBeInstanceOf(StreamError);
		await expect(operation).rejects.toMatchObject({ reason: "cannot-open" });
		expect(f.createDeriver).not.toHaveBeenCalled();
		expect(f.wdk).toEqual(new Uint8Array(32).fill(3));
	});
	it.each([
		"wrong",
		"leading-zero",
		"empty",
	] as const)("refuses present noncanonical or mismatched Content-Length: %s", async (kind) => {
		const f = await realCryptoFixture();
		const length =
			kind === "wrong"
				? String(f.content.length + 1)
				: kind === "leading-zero"
					? `0${f.content.length}`
					: "";
		vi.spyOn(browserE2eRuntime, "fetcher").mockResolvedValue(
			new Response(f.content.slice(), {
				headers: { "content-length": length },
			}),
		);
		const value = createAttachmentExportController({
			...f.c.options,
			createDeriver: f.createDeriver,
		});
		await expect(
			value.exportSelected([f.encryptedSource], "archive passphrase"),
		).rejects.toMatchObject({ code: "transfer-failed" });
		expect(f.createDeriver).not.toHaveBeenCalled();
	});
	it.each([
		["download", "short"],
		["download", "overlong"],
		["thumbnail", "short"],
		["thumbnail", "overlong"],
	] as const)("refuses headerless %s with %s observed bytes before KDF", async (suffix, kind) => {
		const f = await realCryptoFixture();
		const original = suffix === "download" ? f.content : f.thumbnail;
		const changed =
			kind === "short"
				? original.slice(0, -1)
				: new Uint8Array([...original, 0]);
		serveCiphertext(
			suffix === "download" ? changed : f.content,
			suffix === "thumbnail" ? changed : f.thumbnail,
			false,
		);
		const value = createAttachmentExportController({
			...f.c.options,
			createDeriver: f.createDeriver,
		});
		await expect(
			value.exportSelected([f.encryptedSource], "archive passphrase"),
		).rejects.toMatchObject({ code: "transfer-failed" });
		expect(f.createDeriver).not.toHaveBeenCalled();
		expect(f.wdk).toEqual(new Uint8Array(32).fill(3));
	});
	it("refuses account retirement during a held ciphertext read and cancels the response body without creating a KDF worker", async () => {
		const f = await realCryptoFixture();
		let body: ReadableStreamDefaultController<Uint8Array> | undefined;
		let started: (() => void) | undefined;
		const reading = new Promise<void>((resolve) => {
			started = resolve;
		});
		const cancel = vi.fn();
		vi.spyOn(browserE2eRuntime, "fetcher").mockImplementation(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>(
						{
							start(controller) {
								body = controller;
							},
							pull() {
								started?.();
							},
							cancel,
						},
						// Pull only after the actual controller requests its next chunk.
						{ highWaterMark: 0 },
					),
					{ headers: { "content-length": String(f.content.length) } },
				),
		);
		const value = createAttachmentExportController({
			...f.c.options,
			createDeriver: f.createDeriver,
		});
		const operation = value.exportSelected(
			[f.encryptedSource],
			"archive passphrase",
		);
		const refused = expect(operation).rejects.toMatchObject({ code: "stale" });
		await reading;
		f.c.retire();
		if (!body) throw new Error("held response controller absent");
		body.enqueue(f.content);
		await refused;
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(f.createDeriver).not.toHaveBeenCalled();
		expect(f.wdk).toEqual(new Uint8Array(32).fill(3));
	});
});
