import { describe, expect, it, vi } from "vitest";
import { aad, encryptWrapped } from "../../../domain/e2e/envelope.ts";
import { encryptStream } from "../../../domain/e2e/stream.ts";
import {
	decodeBytes,
	encodeBytes,
	encodeWrapped,
} from "../../../domain/e2e/wire.ts";
import {
	type AttachmentArchiveManifestContract,
	attachmentArchiveAad,
} from "../../../domain/portability/attachment-archive.ts";
import type { PortableExportV1 } from "../../../domain/portability/v1.ts";
import { openAttachmentArchive } from "./attachment-archive.ts";
import type { Deriver } from "./derive.ts";

type Mutable<T> = T extends readonly (infer Item)[]
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
const archiveId = "d7c195de-fd79-4598-bf09-1d542378ee55";
const entryId = "437ba766-b159-46c8-b6f1-ab0d02eb75bf";
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
	const joined = new Uint8Array(
		chunks.reduce((sum, chunk) => sum + chunk.length, 0),
	);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.length;
	}
	return joined;
}
async function fixture() {
	const dek = new Uint8Array(32).fill(9);
	const content = await stream(dek, "content");
	const thumbnail = await stream(dek, "thumbnail");
	const archive = {
		format: "ditero-attachment-archive",
		schemaVersion: 1,
		archiveId,
		unlock: { kdfVersion: 1 as const, salt: encodeBytes(new Uint8Array(16)) },
		protectedManifest: "",
		objects: [
			{
				entryId,
				content: encodeBytes(content),
				thumbnail: encodeBytes(thumbnail),
			},
		],
	};
	const entry: Mutable<AttachmentArchiveManifestContract>["entries"][number] = {
		entryId,
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
		locallyExportedDek: encodeBytes(dek),
		content: { bytes: content.length, sha256: await digest(content) },
		thumbnail: { bytes: thumbnail.length, sha256: await digest(thumbnail) },
	};
	const document = documentValue();
	const row = document.data.attachments[0];
	if (!row) throw new Error("fixture row missing");
	Object.assign(row, {
		declaredBytes: entry.content.bytes,
		observedBytes: entry.content.bytes,
		ciphertextSha256: entry.content.sha256,
		thumbnailDeclaredBytes: entry.thumbnail?.bytes,
		thumbnailObservedBytes: entry.thumbnail?.bytes,
		thumbnailCiphertextSha256: entry.thumbnail?.sha256,
	});
	const manifest: Mutable<AttachmentArchiveManifestContract> = {
		archiveId,
		exportedAt: "2026-10-05T00:00:00.000Z",
		contentDocument: {
			format: "ditero",
			schemaVersion: 1,
			exactBytesSha256: "",
			sourceUserId: "source-user",
			sourceNamespace: null,
		},
		entries: [entry],
	};
	async function seal(bytes?: Uint8Array) {
		const documentJSON = JSON.stringify(document);
		manifest.contentDocument.exactBytesSha256 = await digest(
			text.encode(documentJSON),
		);
		archive.protectedManifest = encodeWrapped(
			await encryptWrapped(
				bytes ?? text.encode(JSON.stringify(manifest)),
				key,
				attachmentArchiveAad(archive),
			),
		);
		return { inputJSON: JSON.stringify(archive), documentJSON };
	}
	const derived = key.slice();
	const deriver: Deriver = {
		derive: vi.fn(async () => derived),
		dispose: vi.fn(),
	};
	return {
		archive,
		manifest,
		entry,
		document,
		row,
		seal,
		derived,
		deriver,
		dek,
	};
}
const open = async (
	f: Awaited<ReturnType<typeof fixture>>,
	document?: string,
) => {
	const sealed = await f.seal();
	return openAttachmentArchive(
		sealed.inputJSON,
		document ?? sealed.documentJSON,
		"secret",
		{ createDeriver: () => f.deriver },
	);
};
describe("authenticated attachment archive opening", () => {
	it("opens real metadata and complete multi-segment content and thumbnail, then erases KEK and disposes owned worker", async () => {
		const f = await fixture();
		const result = await open(f);
		expect(result.manifest.entries[0]?.source.id).toBe("source-file");
		expect(Object.isFrozen(result.manifest)).toBe(true);
		expect(f.deriver.derive).toHaveBeenCalledWith(
			"secret",
			new Uint8Array(16),
			"passphrase",
			1,
		);
		expect(f.derived).toEqual(new Uint8Array(32));
		expect(f.deriver.dispose).toHaveBeenCalledOnce();
		expect(Object.keys(result)).toEqual(["archive", "manifest"]);
	});
	it("refuses malformed outer input before creating a worker", async () => {
		const create = vi.fn();
		await expect(
			openAttachmentArchive("{}", "{}", "secret", { createDeriver: create }),
		).rejects.toThrow();
		expect(create).not.toHaveBeenCalled();
	});
	it("refuses wrong secret through actual AES-GCM authentication", async () => {
		const f = await fixture();
		f.deriver.derive = vi.fn(async () => new Uint8Array(32).fill(99));
		await expect(open(f)).rejects.toThrow("cannot open");
		expect(f.deriver.dispose).toHaveBeenCalledOnce();
	});
	it("refuses changed archive AAD even with the correct key", async () => {
		const f = await fixture();
		const sealed = await f.seal();
		f.archive.archiveId = "e7c195de-fd79-4598-bf09-1d542378ee55";
		await expect(
			openAttachmentArchive(
				JSON.stringify(f.archive),
				sealed.documentJSON,
				"secret",
				{ createDeriver: () => f.deriver },
			),
		).rejects.toThrow("cannot open");
	});
	it("refuses authenticated but invalid UTF-8 manifest", async () => {
		const f = await fixture();
		const sealed = await f.seal(new Uint8Array([0xff]));
		await expect(
			openAttachmentArchive(sealed.inputJSON, sealed.documentJSON, "secret", {
				createDeriver: () => f.deriver,
			}),
		).rejects.toThrow();
		expect(f.derived).toEqual(new Uint8Array(32));
	});
	it("binds exact portable bytes including whitespace", async () => {
		const f = await fixture();
		const sealed = await f.seal();
		await expect(
			openAttachmentArchive(
				sealed.inputJSON,
				`${sealed.documentJSON} `,
				"secret",
				{ createDeriver: () => f.deriver },
			),
		).rejects.toThrow("binding-mismatch");
	});
	it("rejects a claimed parent differing from the hash-bound portable attachment row", async () => {
		const f = await fixture();
		f.entry.source.parentId = "other-task";
		await expect(open(f)).rejects.toThrow("binding-mismatch");
	});
	it("checks object hash before accepting authenticated stream", async () => {
		const f = await fixture();
		const sealed = await f.seal();
		const modified = decodeBytes(f.archive.objects[0].content);
		modified[40] ^= 1;
		f.archive.objects[0].content = encodeBytes(modified);
		await expect(
			openAttachmentArchive(
				JSON.stringify(f.archive),
				sealed.documentJSON,
				"secret",
				{ createDeriver: () => f.deriver },
			),
		).rejects.toThrow("binding-mismatch");
	});
	it("rejects a tampered final tag even when manifest and portable row honestly hash those tampered ciphertext bytes", async () => {
		const f = await fixture();
		const bad = decodeBytes(f.archive.objects[0].content);
		bad[bad.length - 1] ^= 1;
		f.archive.objects[0].content = encodeBytes(bad);
		f.entry.content.sha256 = await digest(bad);
		f.row.ciphertextSha256 = f.entry.content.sha256;
		await expect(open(f)).rejects.toThrow("Cannot open segment 2");
	});
	it("authenticates metadata against its original source identity", async () => {
		const f = await fixture();
		f.entry.source.filenameCiphertext = encodeWrapped(
			await encryptWrapped(
				text.encode("file.txt"),
				f.dek,
				aad.metadata("different-file", "filename"),
			),
		);
		await expect(open(f)).rejects.toThrow("cannot open");
	});
	it("authenticates thumbnail purpose separately despite a matching manifest hash", async () => {
		const f = await fixture();
		const wrong = await stream(f.dek, "content");
		f.archive.objects[0].thumbnail = encodeBytes(wrong);
		if (!f.entry.thumbnail) throw new Error("thumbnail missing");
		f.entry.thumbnail.sha256 = await digest(wrong);
		f.row.thumbnailCiphertextSha256 = f.entry.thumbnail.sha256;
		await expect(open(f)).rejects.toThrow("Cannot open segment 0");
	});
	it("cancels a held KDF immediately, disposes only the operation worker, and erases a late KEK", async () => {
		const f = await fixture();
		const sealed = await f.seal();
		const abort = new AbortController();
		let resolve: (key: Uint8Array) => void = () => {};
		f.deriver.derive = vi.fn(
			() =>
				new Promise<Uint8Array>((r) => {
					resolve = r;
				}),
		);
		const operation = openAttachmentArchive(
			sealed.inputJSON,
			sealed.documentJSON,
			"secret",
			{ signal: abort.signal, createDeriver: () => f.deriver },
		);
		abort.abort();
		await expect(operation).rejects.toMatchObject({ name: "AbortError" });
		expect(f.deriver.dispose).toHaveBeenCalledOnce();
		const late = key.slice();
		resolve(late);
		await Promise.resolve();
		expect(late).toEqual(new Uint8Array(32));
	});
	it("erases a real decrypted segment and manifest buffer when cancellation arrives during stream authentication", async () => {
		const f = await fixture();
		const sealed = await f.seal();
		const abort = new AbortController();
		const original = crypto.subtle.decrypt.bind(crypto.subtle);
		const plaintexts: ArrayBuffer[] = [];
		const spy = vi
			.spyOn(crypto.subtle, "decrypt")
			.mockImplementation(async (...args) => {
				const plaintext = await original(...args);
				plaintexts.push(plaintext);
				if (plaintexts.length === 4) abort.abort();
				return plaintext;
			});
		try {
			await expect(
				openAttachmentArchive(sealed.inputJSON, sealed.documentJSON, "secret", {
					signal: abort.signal,
					createDeriver: () => f.deriver,
				}),
			).rejects.toMatchObject({ name: "AbortError" });
			expect(plaintexts).toHaveLength(4);
			for (const plaintext of plaintexts)
				expect(new Uint8Array(plaintext)).toEqual(
					new Uint8Array(plaintext.byteLength),
				);
			expect(f.derived).toEqual(new Uint8Array(32));
			expect(f.deriver.dispose).toHaveBeenCalledOnce();
		} finally {
			spy.mockRestore();
		}
	});
	it("refuses an already-cancelled operation before parsing or allocating its worker", async () => {
		const abort = new AbortController();
		abort.abort();
		const create = vi.fn();
		await expect(
			openAttachmentArchive("{}", "{}", "secret", {
				signal: abort.signal,
				createDeriver: create,
			}),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(create).not.toHaveBeenCalled();
	});
});
