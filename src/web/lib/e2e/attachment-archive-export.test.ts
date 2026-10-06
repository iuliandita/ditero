import { describe, expect, it, vi } from "vitest";
import {
	aad,
	EnvelopeOpenError,
	encryptWrapped,
} from "../../../domain/e2e/envelope.ts";
import { encryptStream, StreamError } from "../../../domain/e2e/stream.ts";
import { encodeWrapped } from "../../../domain/e2e/wire.ts";
import { AttachmentArchiveContractError } from "../../../domain/portability/attachment-archive.ts";
import type { PortableExportV1 } from "../../../domain/portability/v1.ts";
import { openAttachmentArchive } from "./attachment-archive.ts";
import {
	type AuthorizedArchiveSource,
	exportAttachmentArchive,
} from "./attachment-archive-export.ts";
import type { Deriver } from "./derive.ts";

type Mutable<T> = T extends Uint8Array
	? T
	: T extends readonly (infer Item)[]
		? Mutable<Item>[]
		: T extends object
			? { -readonly [K in keyof T]: Mutable<T[K]> }
			: T;
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

const text = new TextEncoder();
const key = new Uint8Array(32).fill(7);
async function digest(value: Uint8Array) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new Uint8Array(value)),
		),
		(x) => x.toString(16).padStart(2, "0"),
	).join("");
}
async function stream(dek: Uint8Array, purpose: "content" | "thumbnail") {
	async function* plain() {
		yield new Uint8Array(2050).fill(4);
	}
	const chunks: Uint8Array[] = [];
	for await (const chunk of encryptStream(plain(), dek, purpose, 1024))
		chunks.push(chunk);
	const result = new Uint8Array(
		chunks.reduce((sum, chunk) => sum + chunk.length, 0),
	);
	let at = 0;
	for (const chunk of chunks) {
		result.set(chunk, at);
		at += chunk.length;
	}
	return result;
}
async function fixture() {
	const dek = new Uint8Array(32).fill(9);
	const content = await stream(dek, "content");
	const thumbnail = await stream(dek, "thumbnail");
	const selected: Mutable<AuthorizedArchiveSource> = {
		dek,
		content,
		thumbnail,
		source: {
			id: "source-file",
			workspaceId: "source-workspace",
			keyVersion: 1,
			parentKind: "task",
			parentId: "source-task",
			filenameCiphertext: encodeWrapped(
				await encryptWrapped(
					text.encode("file.txt"),
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
					new Uint8Array(32).fill(3),
					aad.dek("source-workspace", 1, "source-file"),
				),
			),
		},
	};
	const document = documentValue();
	const row = document.data.attachments[0];
	if (!row) throw new Error("fixture missing row");
	row.declaredBytes = row.observedBytes = content.length;
	row.ciphertextSha256 = await digest(content);
	row.thumbnailDeclaredBytes = row.thumbnailObservedBytes = thumbnail.length;
	row.thumbnailCiphertextSha256 = await digest(thumbnail);
	const derive = vi.fn(async () => new Uint8Array(key));
	const dispose = vi.fn();
	const createDeriver = vi.fn((): Deriver => ({ derive, dispose }));
	return { selected, document, derive, dispose, createDeriver };
}

async function expectArchiveRefusal(
	operation: Promise<unknown>,
	errorType:
		| typeof EnvelopeOpenError
		| typeof StreamError
		| typeof AttachmentArchiveContractError,
	shape: { reason: "cannot-open" } | { code: "binding-mismatch" },
) {
	await expect(operation).rejects.toBeInstanceOf(errorType);
	await expect(operation).rejects.toMatchObject(shape);
}

describe("attachment archive export", () => {
	it("opens the complete real encrypted export and preserves caller-owned keys", async () => {
		const f = await fixture();
		const document = JSON.stringify(f.document);
		const result = await exportAttachmentArchive(
			document,
			[f.selected],
			"archive secret",
			{ createDeriver: f.createDeriver },
		);
		expect(f.derive).toHaveBeenCalledWith(
			"archive secret",
			expect.any(Uint8Array),
			"passphrase",
			1,
		);
		expect(f.dispose).toHaveBeenCalledTimes(1);
		expect(f.selected.dek).toEqual(new Uint8Array(32).fill(9));
		expect(await f.derive.mock.results[0]?.value).toEqual(new Uint8Array(32));
		const opened = await openAttachmentArchive(
			result.json,
			document,
			"archive secret",
			{
				createDeriver: () => ({
					derive: async () => new Uint8Array(key),
					dispose() {},
				}),
			},
		);
		expect(opened.manifest.entries[0]?.source.id).toBe("source-file");
		expect(opened.manifest.entries[0]?.content.bytes).toBe(
			f.selected.content.length,
		);
		expect(opened.manifest.entries[0]?.thumbnail?.bytes).toBe(
			f.selected.thumbnail?.length,
		);
	});
	it("uses fresh archive identities, salts and manifest nonces", async () => {
		const f = await fixture();
		const document = JSON.stringify(f.document);
		const a = await exportAttachmentArchive(document, [f.selected], "secret", {
			createDeriver: f.createDeriver,
		});
		const b = await exportAttachmentArchive(document, [f.selected], "secret", {
			createDeriver: f.createDeriver,
		});
		expect(a.archive.archiveId).not.toBe(b.archive.archiveId);
		expect(a.archive.unlock.salt).not.toBe(b.archive.unlock.salt);
		expect(a.archive.protectedManifest).not.toBe(b.archive.protectedManifest);
	});
	it("refuses wrong DEKs and metadata AAD before creating a worker", async () => {
		const f = await fixture();
		f.selected.dek = new Uint8Array(32).fill(8);
		await expectArchiveRefusal(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				[f.selected],
				"secret",
				{ createDeriver: f.createDeriver },
			),
			EnvelopeOpenError,
			{ reason: "cannot-open" },
		);
		expect(f.createDeriver).not.toHaveBeenCalled();
		f.selected.dek = new Uint8Array(32).fill(9);
		f.selected.source.filenameCiphertext = encodeWrapped(
			await encryptWrapped(
				text.encode("file.txt"),
				f.selected.dek,
				aad.metadata("another-file", "filename"),
			),
		);
		await expectArchiveRefusal(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				[f.selected],
				"secret",
				{ createDeriver: f.createDeriver },
			),
			EnvelopeOpenError,
			{ reason: "cannot-open" },
		);
		expect(f.createDeriver).not.toHaveBeenCalled();
	});
	it("refuses a valid earlier prefix with a tampered final segment even when its saved hash matches", async () => {
		const f = await fixture();
		const last = f.selected.content.length - 1;
		f.selected.content[last] = (f.selected.content[last] ?? 0) ^ 1;
		const row = f.document.data.attachments[0];
		if (!row) throw new Error("fixture missing row");
		row.ciphertextSha256 = await digest(f.selected.content);
		await expectArchiveRefusal(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				[f.selected],
				"secret",
				{ createDeriver: f.createDeriver },
			),
			StreamError,
			{ reason: "cannot-open" },
		);
		expect(f.createDeriver).not.toHaveBeenCalled();
	});
	it("refuses the wrong thumbnail stream purpose despite matching saved hash", async () => {
		const f = await fixture();
		f.selected.thumbnail = await stream(f.selected.dek, "content");
		const row = f.document.data.attachments[0];
		if (!row) throw new Error("fixture missing row");
		row.thumbnailDeclaredBytes = row.thumbnailObservedBytes =
			f.selected.thumbnail.length;
		row.thumbnailCiphertextSha256 = await digest(f.selected.thumbnail);
		await expectArchiveRefusal(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				[f.selected],
				"secret",
				{ createDeriver: f.createDeriver },
			),
			StreamError,
			{ reason: "cannot-open" },
		);
		expect(f.createDeriver).not.toHaveBeenCalled();
	});
	it("refuses changed document parents, hashes and committed state before KDF", async () => {
		for (const mutation of ["parent", "hash", "committed"] as const) {
			const f = await fixture();
			const row = f.document.data.attachments[0];
			if (!row) throw new Error("fixture missing row");
			if (mutation === "parent") row.parentId = "another-task";
			if (mutation === "hash") row.ciphertextSha256 = "0".repeat(64);
			if (mutation === "committed") row.committedAt = null;
			await expectArchiveRefusal(
				exportAttachmentArchive(
					JSON.stringify(f.document),
					[f.selected],
					"secret",
					{ createDeriver: f.createDeriver },
				),
				AttachmentArchiveContractError,
				{ code: "binding-mismatch" },
			);
			expect(f.createDeriver).not.toHaveBeenCalled();
		}
	});
	it("admits exact manifest bytes before KDF rather than assuming 64 entries fit", async () => {
		const f = await fixture();
		f.selected.source.filenameCiphertext = encodeWrapped(
			await encryptWrapped(
				new Uint8Array(25000),
				f.selected.dek,
				aad.metadata("source-file", "filename"),
			),
		);
		await expect(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				[f.selected],
				"secret",
				{ createDeriver: f.createDeriver },
			),
		).rejects.toThrow("byte-limit");
		expect(f.createDeriver).not.toHaveBeenCalled();
	});
	it("refuses aggregate ciphertext and selection count bounds before KDF", async () => {
		const f = await fixture();
		await expect(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				Array.from({ length: 65 }, () => f.selected),
				"secret",
				{ createDeriver: f.createDeriver },
			),
		).rejects.toThrow("byte-limit");
		f.selected.content = new Uint8Array(16 * 1024 * 1024 + 1);
		await expect(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				[f.selected],
				"secret",
				{ createDeriver: f.createDeriver },
			),
		).rejects.toThrow("byte-limit");
		expect(f.createDeriver).not.toHaveBeenCalled();
	});
	it("aborts a held derivation, disposes its owner and erases the late KEK without returning output", async () => {
		const f = await fixture();
		const controller = new AbortController();
		let release: (value: Uint8Array) => void = () => {};
		let entered: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const pending = new Promise<Uint8Array>((resolve) => {
			release = resolve;
		});
		const dispose = vi.fn();
		const result = exportAttachmentArchive(
			JSON.stringify(f.document),
			[f.selected],
			"secret",
			{
				signal: controller.signal,
				createDeriver: () => ({
					derive: () => {
						entered();
						return pending;
					},
					dispose,
				}),
			},
		);
		await started;
		controller.abort(new Error("cancel archive"));
		await expect(result).rejects.toThrow("cancel archive");
		expect(dispose).toHaveBeenCalledTimes(1);
		const late = new Uint8Array(key);
		release(late);
		await Promise.resolve();
		await Promise.resolve();
		expect(late).toEqual(new Uint8Array(32));
		expect(f.selected.dek).toEqual(new Uint8Array(32).fill(9));
	});
	it("captures source ciphertext and DEKs before its first await", async () => {
		const f = await fixture();
		const document = JSON.stringify(f.document);
		const result = exportAttachmentArchive(document, [f.selected], "secret", {
			createDeriver: f.createDeriver,
		});
		f.selected.dek.fill(0);
		f.selected.content.fill(0);
		f.selected.source.parentId = "changed";
		const exported = await result;
		const opened = await openAttachmentArchive(
			exported.json,
			document,
			"secret",
			{
				createDeriver: () => ({
					derive: async () => new Uint8Array(key),
					dispose() {},
				}),
			},
		);
		expect(opened.manifest.entries[0]?.source.parentId).toBe("source-task");
	});
	it("erases authenticated plaintext when cancellation arrives during the first stream segment", async () => {
		const f = await fixture();
		const controller = new AbortController();
		const original = crypto.subtle.decrypt.bind(crypto.subtle);
		const plaintexts: ArrayBuffer[] = [];
		const spy = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (...args) => {
				const plaintext = await original(...args);
				plaintexts.push(plaintext);
				if (plaintexts.length === 3) controller.abort();
				return plaintext;
			});
		try {
			await expect(
				exportAttachmentArchive(
					JSON.stringify(f.document),
					[f.selected],
					"secret",
					{ signal: controller.signal, createDeriver: f.createDeriver },
				),
			).rejects.toMatchObject({ name: "AbortError" });
			expect(plaintexts).toHaveLength(3);
			for (const plaintext of plaintexts)
				expect(new Uint8Array(plaintext)).toEqual(
					new Uint8Array(plaintext.byteLength),
				);
			expect(f.createDeriver).not.toHaveBeenCalled();
			expect(f.selected.dek).toEqual(new Uint8Array(32).fill(9));
		} finally {
			spy.mockRestore();
		}
	});
	it("refuses pre-aborted operations without allocating a deriver", async () => {
		const f = await fixture();
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			exportAttachmentArchive(
				JSON.stringify(f.document),
				[f.selected],
				"secret",
				{ signal: controller.signal, createDeriver: f.createDeriver },
			),
		).rejects.toThrow("cancelled");
		expect(f.createDeriver).not.toHaveBeenCalled();
	});
});
