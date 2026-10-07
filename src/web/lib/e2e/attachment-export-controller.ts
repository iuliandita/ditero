import { sanitiseFilename } from "../../../domain/attachment.ts";
import {
	aad,
	decryptWrapped,
	TAG_BYTES,
} from "../../../domain/e2e/envelope.ts";
import {
	decodeWrapped,
	encodeBytes,
	encodeWrapped,
	MAX_WRAPPED_LENGTH,
} from "../../../domain/e2e/wire.ts";
import {
	ATTACHMENT_ARCHIVE_LIMITS,
	AttachmentArchiveContractError,
	type AttachmentArchiveManifestContract,
	assertAttachmentArchivePortableRowBinding,
	parseAttachmentArchiveManifestContract,
} from "../../../domain/portability/attachment-archive.ts";
import { parseImportDocument } from "../../../domain/portability/import-document.ts";
import { isZeroClientOwnerActive } from "../zero-lifecycle.ts";
import {
	type AuthorizedArchiveSource,
	exportAttachmentArchive,
} from "./attachment-archive-export.ts";
import type { Deriver } from "./derive.ts";
import type { KeyringContextValue } from "./KeyringProvider.tsx";
import { supportsAttachmentArchiveExport } from "./runtime.ts";

type Source = AttachmentArchiveManifestContract["entries"][number]["source"];
type Progress = {
	stage: "download" | "authenticate-and-seal";
	id: string | null;
	loaded: number;
	total: number;
};
export class AttachmentExportSelectionError extends Error {
	constructor(
		readonly code:
			| "native-unavailable"
			| "locked"
			| "stale"
			| "busy"
			| "transfer-failed"
			| "invalid-selection",
	) {
		super(`attachment export selection: ${code}`);
		this.name = "AttachmentExportSelectionError";
	}
}

// The caller captures this document after its existing accepted-write boundary.
// Synced envelopes are frozen here; downloads independently recheck live authority.
export function createAttachmentExportController(options: {
	exactContentDocument: string;
	ownerId: string;
	zero: Parameters<typeof isZeroClientOwnerActive>[0];
	keyring: () => KeyringContextValue;
	onProgress?: (progress: Progress) => void;
	createDeriver?: () => Deriver;
	signal?: AbortSignal;
}) {
	const {
		exactContentDocument,
		ownerId,
		zero,
		keyring,
		onProgress,
		createDeriver,
		signal,
	} = options;
	const runtime = keyring().runtime;
	const owner = () => zero.userID === ownerId && isZeroClientOwnerActive(zero);
	const abort = new AbortController();
	const document = parseImportDocument(exactContentDocument, {
		historyPreview: true,
	});
	if (!owner() || document.sourceUserId !== ownerId)
		throw new AttachmentExportSelectionError("stale");
	const rows = new Map(document.data.attachments.map((row) => [row.id, row]));
	if (rows.size !== document.data.attachments.length)
		throw new AttachmentExportSelectionError("invalid-selection");
	const forwardAbort = () => abort.abort(signal?.reason);
	if (signal?.aborted) forwardAbort();
	else signal?.addEventListener("abort", forwardAbort, { once: true });
	let busy = false;
	const checkpoint = () => {
		abort.signal.throwIfAborted();
		if (!owner()) throw new AttachmentExportSelectionError("stale");
		const keys = keyring();
		if (keys.runtime !== runtime)
			throw new AttachmentExportSelectionError("stale");
		if (!supportsAttachmentArchiveExport(runtime))
			throw new AttachmentExportSelectionError("native-unavailable");
		if (!keys.ready || keys.state !== "ready")
			throw new AttachmentExportSelectionError("locked");
		return keys;
	};
	// Validate primitives before serialization; never copy arbitrary caller objects.
	const boundedSources = (sources: readonly Source[]): Source[] => {
		let wireCharacters = 0;
		return sources.map((source) => {
			if (!source || typeof source !== "object")
				throw new AttachmentExportSelectionError("invalid-selection");
			for (const field of ["id", "workspaceId", "parentId"] as const) {
				const value = source[field];
				if (
					typeof value !== "string" ||
					value.length < 1 ||
					value.length > 128 ||
					!/^[A-Za-z0-9_-]+$/.test(value)
				)
					throw new AttachmentExportSelectionError("invalid-selection");
			}
			if (
				!Number.isInteger(source.keyVersion) ||
				source.keyVersion < 1 ||
				source.keyVersion > 2_147_483_647 ||
				!["task", "comment", "list"].includes(source.parentKind)
			)
				throw new AttachmentExportSelectionError("invalid-selection");
			for (const field of [
				"filenameCiphertext",
				"contentTypeCiphertext",
				"dekWrapped",
			] as const) {
				const value = source[field];
				if (
					typeof value !== "string" ||
					value.length < 1 ||
					value.length > MAX_WRAPPED_LENGTH
				)
					throw new AttachmentExportSelectionError("invalid-selection");
				wireCharacters += value.length;
				if (wireCharacters > ATTACHMENT_ARCHIVE_LIMITS.manifestBytes)
					throw new AttachmentArchiveContractError("byte-limit");
				try {
					const wrapped = decodeWrapped(value);
					if (
						encodeWrapped(wrapped) !== value ||
						(field === "dekWrapped" &&
							wrapped.ciphertext.length !== 32 + TAG_BYTES)
					)
						throw new Error("invalid envelope");
				} catch {
					throw new AttachmentExportSelectionError("invalid-selection");
				}
			}
			return {
				id: source.id,
				workspaceId: source.workspaceId,
				parentId: source.parentId,
				parentKind: source.parentKind,
				keyVersion: source.keyVersion,
				filenameCiphertext: source.filenameCiphertext,
				contentTypeCiphertext: source.contentTypeCiphertext,
				dekWrapped: source.dekWrapped,
			};
		});
	};
	// This validates the actual protected-manifest size before downloads or any KDF.
	// Dummy fixed-width identities/DEK/hash have exactly the eventual encoded lengths.
	const preflight = (sources: readonly Source[]) => {
		checkpoint();
		if (!sources.length || sources.length > ATTACHMENT_ARCHIVE_LIMITS.entries)
			throw new AttachmentExportSelectionError("invalid-selection");
		let total = 0;
		const manifest = parseAttachmentArchiveManifestContract(
			JSON.stringify({
				archiveId: "00000000-0000-4000-8000-000000000000",
				exportedAt: document.exportedAt,
				contentDocument: {
					format: document.format,
					schemaVersion: document.schemaVersion,
					exactBytesSha256: "0".repeat(64),
					sourceUserId: document.sourceUserId,
					sourceNamespace:
						document.schemaVersion === 2 ? document.sourceNamespace : null,
				},
				entries: sources.map((source, index) => {
					const row = rows.get(source.id);
					if (
						!row ||
						row.committedAt === null ||
						row.observedBytes === null ||
						row.ciphertextSha256 === null
					)
						throw new AttachmentExportSelectionError("invalid-selection");
					total += row.observedBytes + (row.thumbnailObservedBytes ?? 0);
					if (
						!Number.isSafeInteger(total) ||
						total > ATTACHMENT_ARCHIVE_LIMITS.ciphertextBytes
					)
						throw new AttachmentArchiveContractError("byte-limit");
					return {
						entryId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
						source,
						locallyExportedDek: encodeBytes(new Uint8Array(32)),
						content: { bytes: row.observedBytes, sha256: row.ciphertextSha256 },
						thumbnail:
							row.thumbnailObservedBytes === null
								? null
								: {
										bytes: row.thumbnailObservedBytes,
										sha256: row.thumbnailCiphertextSha256,
									},
					};
				}),
			}),
		);
		assertAttachmentArchivePortableRowBinding(manifest, document);
		if (new Set(sources.map((source) => source.id)).size !== sources.length)
			throw new AttachmentExportSelectionError("invalid-selection");
		return manifest.entries;
	};
	const freezeSources = (sources: readonly Source[]) => {
		if (
			!Array.isArray(sources) ||
			!sources.length ||
			sources.length > ATTACHMENT_ARCHIVE_LIMITS.entries
		)
			throw new AttachmentExportSelectionError("invalid-selection");
		return preflight(boundedSources(sources)).map((entry) =>
			Object.freeze({ ...entry.source }),
		);
	};
	async function withDek<T>(
		source: Source,
		callback: (dek: Uint8Array) => Promise<T>,
	): Promise<T> {
		const keys = checkpoint();
		const key = await keys.workspaceKey(source.workspaceId, source.keyVersion);
		checkpoint();
		if (
			!key ||
			key.workspaceId !== source.workspaceId ||
			key.keyVersion !== source.keyVersion ||
			key.wdk.length !== 32
		)
			throw new AttachmentExportSelectionError("locked");
		// WDK belongs to the account keyring. Only this copy and the opened DEK are ours.
		const wdk = key.wdk.slice();
		let dek: Uint8Array | undefined;
		try {
			dek = await decryptWrapped(
				decodeWrapped(source.dekWrapped),
				wdk,
				aad.dek(source.workspaceId, source.keyVersion, source.id),
			);
			checkpoint();
			if (dek.length !== 32)
				throw new AttachmentExportSelectionError("invalid-selection");
			return await callback(dek);
		} finally {
			wdk.fill(0);
			dek?.fill(0);
		}
	}
	async function download(
		source: Source,
		suffix: "download" | "thumbnail",
		size: number,
	): Promise<Uint8Array> {
		const keys = checkpoint();
		const response = await (
			keys.runtime.attachments?.fetcher ?? keys.runtime.fetcher
		)(`/api/attachments/${encodeURIComponent(source.id)}/${suffix}`, {
			credentials: "same-origin",
			signal: abort.signal,
		});
		try {
			checkpoint();
			const contentLength = response.headers.get("content-length");
			if (
				!response.ok ||
				!response.body ||
				(contentLength !== null && contentLength !== String(size))
			)
				throw new AttachmentExportSelectionError("transfer-failed");
			const reader = response.body.getReader();
			let complete = false;
			const bytes = new Uint8Array(size);
			let loaded = 0;
			try {
				onProgress?.({ stage: "download", id: source.id, loaded, total: size });
				while (true) {
					const chunk = await reader.read();
					checkpoint();
					if (chunk.done) {
						complete = true;
						break;
					}
					if (chunk.value.byteLength > size - loaded)
						throw new AttachmentExportSelectionError("transfer-failed");
					bytes.set(chunk.value, loaded);
					loaded += chunk.value.byteLength;
					onProgress?.({
						stage: "download",
						id: source.id,
						loaded,
						total: size,
					});
				}
				if (loaded !== size)
					throw new AttachmentExportSelectionError("transfer-failed");
				return bytes;
			} finally {
				if (!complete) await reader.cancel().catch(() => undefined);
				reader.releaseLock();
			}
		} finally {
			if (response.body && !response.body.locked)
				await response.body.cancel().catch(() => undefined);
		}
	}
	return {
		cancel() {
			signal?.removeEventListener("abort", forwardAbort);
			abort.abort(
				new DOMException("Attachment export cancelled", "AbortError"),
			);
		},
		preflightSelected(sourcesInput: readonly Source[]) {
			const sources = freezeSources(sourcesInput);
			const encryptedBytes = sources.reduce((total, source) => {
				const row = rows.get(source.id);
				return (
					total + (row?.observedBytes ?? 0) + (row?.thumbnailObservedBytes ?? 0)
				);
			}, 0);
			return Object.freeze({
				sources: Object.freeze(sources),
				count: sources.length,
				encryptedBytes,
			});
		},
		// UI must unlock first, then call this before displaying source names.
		async describe(sourceInput: Source) {
			if (busy) throw new AttachmentExportSelectionError("busy");
			busy = true;
			try {
				const [source] = freezeSources([sourceInput]);
				if (!source)
					throw new AttachmentExportSelectionError("invalid-selection");
				return await withDek(source, async (dek) => {
					let filename: Uint8Array | undefined;
					try {
						filename = await decryptWrapped(
							decodeWrapped(source.filenameCiphertext),
							dek,
							aad.metadata(source.id, "filename"),
						);
						checkpoint();
						return {
							id: source.id,
							filename: sanitiseFilename(
								new TextDecoder("utf-8", { fatal: true }).decode(filename),
							),
						};
					} finally {
						filename?.fill(0);
					}
				});
			} finally {
				busy = false;
			}
		},
		async exportSelected(sourcesInput: readonly Source[], passphrase: string) {
			if (busy) throw new AttachmentExportSelectionError("busy");
			busy = true;
			const selected: AuthorizedArchiveSource[] = [];
			try {
				const sources = freezeSources(sourcesInput);
				if (
					typeof passphrase !== "string" ||
					!passphrase.length ||
					passphrase.length > 1024
				)
					throw new AttachmentExportSelectionError("invalid-selection");
				for (const source of sources) {
					const row = rows.get(source.id);
					if (!row || row.observedBytes === null)
						throw new AttachmentExportSelectionError("invalid-selection");
					await withDek(source, async (dek) => {
						const entry: AuthorizedArchiveSource = {
							source,
							dek: dek.slice(),
							content: new Uint8Array(),
							thumbnail: null,
						};
						selected.push(entry);
						entry.content = await download(
							source,
							"download",
							row.observedBytes ?? 0,
						);
						if (row.thumbnailObservedBytes !== null)
							entry.thumbnail = await download(
								source,
								"thumbnail",
								row.thumbnailObservedBytes,
							);
					});
				}
				checkpoint();
				onProgress?.({
					stage: "authenticate-and-seal",
					id: null,
					loaded: 0,
					total: sources.length,
				});
				const result = await exportAttachmentArchive(
					exactContentDocument,
					selected,
					passphrase,
					{ signal: abort.signal, createDeriver },
				);
				checkpoint();
				return Object.freeze({
					archiveId: result.archive.archiveId,
					exportedAt: document.exportedAt,
					content: Object.freeze({
						filename: `ditero-content-${result.archive.archiveId}.json`,
						json: exactContentDocument,
					}),
					files: Object.freeze({
						filename: `ditero-files-${result.archive.archiveId}.json`,
						json: result.json,
					}),
				});
			} finally {
				for (const item of selected) item.dek.fill(0);
				busy = false;
			}
		},
	};
}
