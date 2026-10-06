import { describe, expect, it, vi } from "vitest";
import {
	aad,
	decryptWrapped,
	encryptWrapped,
} from "../../../domain/e2e/envelope.ts";
import {
	decryptStream,
	encryptStream,
	StreamError,
} from "../../../domain/e2e/stream.ts";
import {
	decodeBytes,
	decodeWrapped,
	encodeBytes,
	encodeWrapped,
} from "../../../domain/e2e/wire.ts";
import type { openAttachmentArchive } from "./attachment-archive.ts";
import { prepareAttachmentMigration } from "./attachment-migration-prepare.ts";
import type { ThumbnailPlatform } from "./thumbnail.ts";

const text = new TextEncoder();
async function* source(value: Uint8Array) {
	yield value;
}
async function collect(value: AsyncIterable<Uint8Array>) {
	const parts: Uint8Array[] = [];
	for await (const part of value) parts.push(part);
	const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		result.set(part, at);
		at += part.length;
	}
	return result;
}
async function hash(value: Uint8Array) {
	return Array.from(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new Uint8Array(value)),
		),
		(b) => b.toString(16).padStart(2, "0"),
	).join("");
}
async function fixture(contentType = "text/plain", withThumbnail = false) {
	const dek = new Uint8Array(32).fill(9);
	const plain = new Uint8Array(2050).fill(6);
	const content = await collect(
		encryptStream(source(plain), dek, "content", 1024),
	);
	const thumbnail = withThumbnail
		? await collect(
				encryptStream(source(text.encode("old-thumbnail")), dek, "thumbnail"),
			)
		: null;
	const entry = {
		entryId: "437ba766-b159-46c8-b6f1-ab0d02eb75bf",
		source: {
			id: "old-file",
			workspaceId: "old-workspace",
			keyVersion: 1,
			parentKind: "task" as const,
			parentId: "old-task",
			filenameCiphertext: encodeWrapped(
				await encryptWrapped(
					text.encode("../report.txt"),
					dek,
					aad.metadata("old-file", "filename"),
				),
			),
			contentTypeCiphertext: encodeWrapped(
				await encryptWrapped(
					text.encode(contentType),
					dek,
					aad.metadata("old-file", "contentType"),
				),
			),
			dekWrapped: encodeWrapped(
				await encryptWrapped(
					dek,
					new Uint8Array(32).fill(2),
					aad.dek("old-workspace", 1, "old-file"),
				),
			),
		},
		locallyExportedDek: encodeBytes(dek),
		content: { bytes: content.length, sha256: await hash(content) },
		thumbnail:
			thumbnail === null
				? null
				: { bytes: thumbnail.length, sha256: await hash(thumbnail) },
	};
	const opened: Awaited<ReturnType<typeof openAttachmentArchive>> = {
		archive: {
			format: "ditero-attachment-archive",
			schemaVersion: 1,
			archiveId: "d7c195de-fd79-4598-bf09-1d542378ee55",
			unlock: { kdfVersion: 1, salt: encodeBytes(new Uint8Array(16)) },
			protectedManifest: "unused-authenticated-input",
			objects: [
				{
					entryId: entry.entryId,
					content: encodeBytes(content),
					thumbnail: thumbnail === null ? null : encodeBytes(thumbnail),
				},
			],
		},
		manifest: {
			archiveId: "d7c195de-fd79-4598-bf09-1d542378ee55",
			exportedAt: "2026-10-05T00:00:00.000Z",
			contentDocument: {
				format: "ditero",
				schemaVersion: 1,
				sourceUserId: "old-owner",
				sourceNamespace: null,
				exactBytesSha256: "a".repeat(64),
			},
			entries: [entry],
		},
	};
	return { opened, entry, plain, content, dek };
}
function target() {
	return {
		workspaceId: "new-workspace",
		parentKind: "task" as const,
		parentId: "new-task",
		keyVersion: 7,
		wdk: new Uint8Array(32).fill(3),
	};
}

describe("attachment migration preparation", () => {
	it("prepares fresh ciphertext under the destination key and original metadata AAD without changing borrowed keys", async () => {
		const f = await fixture();
		const destination = target();
		const output = await prepareAttachmentMigration(
			f.opened,
			f.entry.entryId,
			destination,
		);
		expect(output.prepared.id).toMatch(
			/^migration_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		const dek = await decryptWrapped(
			decodeWrapped(output.prepared.dekWrapped),
			destination.wdk,
			aad.dek(destination.workspaceId, 7, output.prepared.id),
		);
		expect(dek).not.toEqual(f.dek);
		expect(
			await collect(decryptStream(source(output.content), dek, "content")),
		).toEqual(f.plain);
		expect(
			new TextDecoder().decode(
				await decryptWrapped(
					decodeWrapped(output.prepared.filenameCiphertext),
					dek,
					aad.metadata(output.prepared.id, "filename"),
				),
			),
		).toBe("report.txt");
		await expect(
			decryptWrapped(
				decodeWrapped(output.prepared.filenameCiphertext),
				dek,
				aad.metadata("old-file", "filename"),
			),
		).rejects.toMatchObject({ reason: "cannot-open" });
		await expect(
			decryptWrapped(
				decodeWrapped(output.prepared.dekWrapped),
				new Uint8Array(32).fill(2),
				aad.dek("old-workspace", 1, "old-file"),
			),
		).rejects.toMatchObject({ reason: "cannot-open" });
		expect(await hash(output.content)).toBe(output.prepared.ciphertextSha256);
		expect(output.content).not.toEqual(f.content);
		expect(output.thumbnail).toBeNull();
		const copy = output.content;
		copy.fill(0);
		expect(await hash(output.content)).toBe(output.prepared.ciphertextSha256);
		expect(destination.wdk).toEqual(new Uint8Array(32).fill(3));
		expect(Object.isFrozen(output.prepared)).toBe(true);
		dek.fill(0);
	});
	it("reaches stream authentication even when the altered ciphertext has a matching declared hash", async () => {
		const f = await fixture();
		f.content[f.content.length - 1] =
			(f.content[f.content.length - 1] ?? 0) ^ 1;
		const opened = {
			...f.opened,
			archive: {
				...f.opened.archive,
				objects: [
					{
						...f.opened.archive.objects[0],
						entryId: f.entry.entryId,
						content: encodeBytes(f.content),
						thumbnail: null,
					},
				],
			},
			manifest: {
				...f.opened.manifest,
				entries: [
					{
						...f.entry,
						content: { bytes: f.content.length, sha256: await hash(f.content) },
					},
				],
			},
		};
		await expect(
			prepareAttachmentMigration(opened, f.entry.entryId, target()),
		).rejects.toBeInstanceOf(StreamError);
		await expect(
			prepareAttachmentMigration(opened, f.entry.entryId, target()),
		).rejects.toMatchObject({ reason: "cannot-open" });
	});
	it("refuses active content and refuses a mandatory thumbnail it cannot safely regenerate", async () => {
		const valid = await fixture();
		await expect(
			prepareAttachmentMigration(valid.opened, valid.entry.entryId, {
				...target(),
				keyVersion: 2147483648,
			}),
		).rejects.toThrow("invalid destination");
		const wrongAadEntry = {
			...valid.entry,
			source: { ...valid.entry.source, id: "different-source-id" },
		};
		await expect(
			prepareAttachmentMigration(
				{
					...valid.opened,
					manifest: { ...valid.opened.manifest, entries: [wrongAadEntry] },
				},
				valid.entry.entryId,
				target(),
			),
		).rejects.toMatchObject({ reason: "cannot-open" });
		const unsafe = await fixture("image/svg+xml");
		await expect(
			prepareAttachmentMigration(unsafe.opened, unsafe.entry.entryId, target()),
		).rejects.toThrow("unsafe content type");
		const unsupported = await fixture("text/plain", true);
		await expect(
			prepareAttachmentMigration(
				unsupported.opened,
				unsupported.entry.entryId,
				target(),
			),
		).rejects.toThrow("unsupported mandatory thumbnail");
	});
	it("authenticates source thumbnail and regenerates a fresh PNG through the existing raster path", async () => {
		const f = await fixture("image/png", true);
		const destination = target();
		const close = vi.fn();
		const encoded = text.encode("regenerated-png");
		const platform: ThumbnailPlatform = {
			decode: async (blob) => {
				expect(blob.type).toBe("image/png");
				expect(new Uint8Array(await blob.arrayBuffer())).toEqual(f.plain);
				return { width: 640, height: 320, source: null, close };
			},
			drawImage: vi.fn(),
			encodePng: async () => new Blob([encoded], { type: "image/png" }),
		};
		const result = await prepareAttachmentMigration(
			f.opened,
			f.entry.entryId,
			destination,
			{ thumbnailPlatform: platform },
		);
		const dek = await decryptWrapped(
			decodeWrapped(result.prepared.dekWrapped),
			destination.wdk,
			aad.dek(destination.workspaceId, 7, result.prepared.id),
		);
		expect(platform.drawImage).toHaveBeenCalledWith(
			expect.anything(),
			320,
			160,
		);
		expect(close).toHaveBeenCalledOnce();
		if (!result.thumbnail) throw new Error("missing regenerated thumbnail");
		expect(
			await collect(decryptStream(source(result.thumbnail), dek, "thumbnail")),
		).toEqual(encoded);
		expect(result.thumbnail).not.toEqual(
			decodeBytes(f.opened.archive.objects[0]?.thumbnail ?? ""),
		);
		expect(await hash(result.thumbnail)).toBe(
			result.prepared.thumbnailCiphertextSha256,
		);
		dek.fill(0);
	});
	it("cancels after a held raster decode without returning preparation and closes the owned bitmap", async () => {
		const f = await fixture("image/png", true);
		const controller = new AbortController();
		const close = vi.fn();
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const platform: ThumbnailPlatform = {
			decode: async () => {
				entered?.();
				await held;
				return { width: 1, height: 1, source: null, close };
			},
			drawImage: vi.fn(),
			encodePng: async () =>
				new Blob([text.encode("png")], { type: "image/png" }),
		};
		const pending = prepareAttachmentMigration(
			f.opened,
			f.entry.entryId,
			target(),
			{ signal: controller.signal, thumbnailPlatform: platform },
		);
		await ready;
		controller.abort(new Error("account retired"));
		release?.();
		await expect(pending).rejects.toThrow("account retired");
		expect(close).toHaveBeenCalledOnce();
	});
});
