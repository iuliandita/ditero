import { sanitiseFilename } from "../../../domain/attachment.ts";
import { byteNarrower } from "../../../domain/e2e/bytes.ts";
import { aad, decryptWrapped } from "../../../domain/e2e/envelope.ts";
import { decodeBytes, decodeWrapped } from "../../../domain/e2e/wire.ts";
import { ATTACHMENT_ARCHIVE_LIMITS } from "../../../domain/portability/attachment-archive.ts";
import { hashImportValue } from "../../../domain/portability/import-digest.ts";
import { parseImportDocument } from "../../../domain/portability/import-document.ts";
import { isZeroClientOwnerActive } from "../zero-lifecycle.ts";
import { openAttachmentArchive } from "./attachment-archive.ts";
import {
	createAttachmentMigrationApi,
	type MigrationBinding,
	type MigrationParentPage,
	type MigrationReservation,
	type MigrationReservationRequest,
	MigrationTransportError,
} from "./attachment-migration-api.ts";
import { prepareAttachmentMigration } from "./attachment-migration-prepare.ts";
import type { KeyringContextValue } from "./KeyringProvider.tsx";
import { browserE2eRuntime } from "./runtime.ts";

type Parent = MigrationParentPage["items"][number];
type Opened = Awaited<ReturnType<typeof openAttachmentArchive>>;
type Frozen = Awaited<ReturnType<typeof prepareAttachmentMigration>>;
export type AttachmentImportStage =
	| "idle"
	| "opening"
	| "open"
	| "discovering"
	| "selected"
	| "preparing"
	| "prepared"
	| "transferring"
	| "uncertain"
	| "complete"
	| "recovery-required"
	| "cancelled"
	| "retired"
	| "error";
export type AttachmentImportState = Readonly<{
	stage: AttachmentImportStage;
	ordinal: number | null;
	code: string | null;
	reservation: Readonly<MigrationReservation> | null;
}>;
export class AttachmentImportError extends Error {
	constructor(readonly code: string) {
		super(code);
		this.name = "AttachmentImportError";
	}
}

// Original archive principals can differ from the captured destination account.
export function createAttachmentImportController(options: {
	binding: MigrationBinding;
	ownerId: string;
	zero: Parameters<typeof isZeroClientOwnerActive>[0];
	keyring: () => KeyringContextValue;
	checkpoint: () => void;
	onState?: (state: AttachmentImportState) => void;
	signal?: AbortSignal;
}) {
	if (options.ownerId !== options.binding.ownerId)
		throw new AttachmentImportError("owner-mismatch");
	const runtime = options.keyring().runtime;
	let retired = false,
		busy = false;
	let abort = new AbortController();
	let state: AttachmentImportState = Object.freeze({
		stage: "idle",
		ordinal: null,
		code: null,
		reservation: null,
	});
	let opened: Opened | undefined;
	let document:
		| ReturnType<typeof parseImportDocument>
		| ReturnType<typeof parseHistoryDocument>
		| undefined;
	let selected: Parent | undefined;
	let frozen: Frozen | undefined;
	let request: MigrationReservationRequest | undefined;
	let reservation: MigrationReservation | undefined;
	let mutation: "reserve" | "upload" | "thumbnail" | "finalize" | null = null;
	const parents = new Map<number, Parent>();
	function parseHistoryDocument(text: string) {
		return parseImportDocument(text, { historyPreview: true });
	}
	function publish(stage: AttachmentImportStage, code: string | null = null) {
		state = Object.freeze({
			stage,
			ordinal: selected?.ordinal ?? null,
			code,
			reservation: reservation ? Object.freeze({ ...reservation }) : null,
		});
		options.onState?.(state);
	}
	function ownership() {
		options.checkpoint();
		if (
			retired ||
			options.zero.userID !== options.ownerId ||
			!isZeroClientOwnerActive(options.zero)
		)
			throw new AttachmentImportError("retired");
		const keys = options.keyring();
		if (
			keys.runtime !== runtime ||
			runtime !== browserE2eRuntime ||
			runtime.attachments
		)
			throw new AttachmentImportError("native-unavailable");
		if (!keys.ready || keys.state !== "ready")
			throw new AttachmentImportError("locked");
		return keys;
	}
	function check() {
		ownership();
		abort.signal.throwIfAborted();
	}
	const api = createAttachmentMigrationApi({
		binding: options.binding,
		checkpoint: ownership,
		fetcher: runtime.fetcher,
	});
	const forwardAbort = () => {
		abort.abort(options.signal?.reason);
	};
	if (options.signal?.aborted) forwardAbort();
	else options.signal?.addEventListener("abort", forwardAbort, { once: true });
	async function wait<T>(promise: Promise<T>) {
		const value = await promise;
		check();
		return value;
	}
	async function run<T>(
		operation: () => Promise<T>,
		resume = false,
	): Promise<T> {
		if (busy) throw new AttachmentImportError("busy");
		busy = true;
		try {
			if (resume && abort.signal.aborted) {
				ownership();
				options.signal?.throwIfAborted();
				abort = new AbortController();
			}
			check();
			return await operation();
		} catch (error) {
			const code =
				error instanceof MigrationTransportError ||
				error instanceof AttachmentImportError
					? error.code
					: "operation-failed";
			if (
				code === "retired" ||
				code === "ownership-lost" ||
				code === "locked" ||
				code === "native-unavailable"
			)
				publish("retired", code);
			else if (
				code === "migration-explicit-recovery-required" ||
				code === "recovery-required" ||
				(error instanceof MigrationTransportError && error.status === 410)
			)
				publish("recovery-required", code);
			else if (
				mutation &&
				(abort.signal.aborted ||
					code === "response-lost" ||
					code === "invalid-response" ||
					code === "reservation-identity-mismatch" ||
					(error instanceof MigrationTransportError && error.uncertain))
			)
				publish("uncertain", code);
			else publish(abort.signal.aborted ? "cancelled" : "error", code);
			throw error;
		} finally {
			busy = false;
		}
	}
	async function fingerprint(parent: Parent) {
		if (!document) throw new AttachmentImportError("archive-not-open");
		const row = document.data.attachments.find(
			(value) => value.id === parent.sourceAttachmentId,
		);
		if (
			!row ||
			(await wait(
				hashImportValue("ditero-attachment-migration-source-v1", row, check),
			)) !== parent.sourceAttachmentFingerprint
		)
			throw new AttachmentImportError("source-fingerprint-mismatch");
	}
	function requirePrepared() {
		if (!frozen || !request)
			throw new AttachmentImportError("preparation-required");
		return { frozen, request };
	}
	function accept(result: MigrationReservation) {
		const current = requirePrepared();
		if (
			result.targetAttachmentId !== current.frozen.prepared.id ||
			!result.attemptId ||
			result.revision !== 1 ||
			(reservation &&
				(result.associationId !== reservation.associationId ||
					result.attemptId !== reservation.attemptId))
		)
			throw new AttachmentImportError("reservation-identity-mismatch");
		reservation = Object.freeze({ ...result });
		if (result.committed) {
			if (!result.committedAt)
				throw new AttachmentImportError("reservation-identity-mismatch");
			publish("complete");
			return true;
		}
		if (
			result.attachmentState === null ||
			result.attachmentState === "aborted" ||
			result.attachmentState === "deleting"
		)
			throw new AttachmentImportError("recovery-required");
		return false;
	}
	async function status() {
		const current = requirePrepared();
		try {
			const result = await wait(
				api.status(
					current.request.ordinal,
					reservation
						? {
								attemptId: reservation.attemptId,
								targetAttachmentId: reservation.targetAttachmentId,
								revision: reservation.revision,
							}
						: undefined,
					abort.signal,
				),
			);
			accept(result);
			return result;
		} catch (error) {
			if (error instanceof MigrationTransportError && error.status === 404) {
				if (reservation) throw new AttachmentImportError("recovery-required");
				return null;
			}
			throw error;
		}
	}
	async function finish(existing: MigrationReservation | null) {
		const current = requirePrepared();
		publish("transferring");
		if (!existing) {
			mutation = "reserve";
			existing = await wait(api.reserve(current.request, abort.signal));
			if (accept(existing)) return;
		}
		if (existing.attachmentState === "reserved") {
			mutation = "upload";
			await wait(
				api.upload(
					current.frozen.prepared,
					new Blob([byteNarrower("attachment import")(current.frozen.content)]),
					abort.signal,
				),
			);
		} else if (existing.attachmentState !== "uploading")
			throw new AttachmentImportError("recovery-required");
		if (current.frozen.thumbnail !== null) {
			mutation = "thumbnail";
			await wait(
				api.thumbnail(
					current.frozen.prepared,
					new Blob([
						byteNarrower("attachment import")(current.frozen.thumbnail),
					]),
					abort.signal,
				),
			);
		}
		mutation = "finalize";
		await wait(api.finalize(current.frozen.prepared, abort.signal));
		const acknowledged = await status();
		if (!acknowledged?.committed)
			throw new MigrationTransportError(
				"acknowledgment-unconfirmed",
				200,
				true,
			);
	}
	return {
		get state() {
			return state;
		},
		describeArchiveSources(): Promise<
			readonly { sourceId: string; filename: string }[]
		> {
			return run(async () => {
				if (!opened) throw new AttachmentImportError("archive-not-open");
				if (opened.manifest.entries.length > ATTACHMENT_ARCHIVE_LIMITS.entries)
					throw new AttachmentImportError("archive-entry-limit");
				const names: { sourceId: string; filename: string }[] = [];
				for (const entry of opened.manifest.entries) {
					check();
					const dek = decodeBytes(entry.locallyExportedDek);
					let plain: Uint8Array | undefined;
					try {
						if (dek.length !== 32)
							throw new AttachmentImportError("invalid-source-key");
						plain = await decryptWrapped(
							decodeWrapped(entry.source.filenameCiphertext),
							dek,
							aad.metadata(entry.source.id, "filename"),
						);
						check();
						names.push(
							Object.freeze({
								sourceId: entry.source.id,
								filename: sanitiseFilename(
									new TextDecoder("utf-8", { fatal: true }).decode(plain),
								),
							}),
						);
					} finally {
						dek.fill(0);
						plain?.fill(0);
					}
				}
				check();
				return Object.freeze(names);
			});
		},
		get archiveSourceIds(): readonly string[] {
			return Object.freeze(
				opened?.manifest.entries.map((entry) => entry.source.id) ?? [],
			);
		},
		get parents() {
			return Array.from(parents.values(), (p) => ({
				...p,
				destinationParent: p.destinationParent
					? { ...p.destinationParent }
					: null,
			}));
		},
		open(
			archiveJSON: string,
			exactContentDocument: string,
			passphrase: string,
		) {
			return run(async () => {
				if (opened || request)
					throw new AttachmentImportError("archive-already-open");
				publish("opening");
				const parsed = parseHistoryDocument(exactContentDocument);
				const value = await wait(
					openAttachmentArchive(archiveJSON, exactContentDocument, passphrase, {
						signal: abort.signal,
					}),
				);
				document = parsed;
				opened = value;
				publish("open");
			});
		},
		discoverPage(query: { afterOrdinal: number; limit: number }) {
			return run(async () => {
				if (!opened || request)
					throw new AttachmentImportError("invalid-stage");
				publish("discovering");
				const page = await wait(api.parents(query, abort.signal));
				for (const parent of page.items) {
					await fingerprint(parent);
					parents.set(
						parent.ordinal,
						Object.freeze({
							...parent,
							destinationParent: parent.destinationParent
								? Object.freeze({ ...parent.destinationParent })
								: null,
						}),
					);
				}
				publish(selected ? "selected" : "open");
				return page;
			});
		},
		select(value: number) {
			check();
			if (busy || request) throw new AttachmentImportError("invalid-stage");
			const parent = parents.get(value);
			if (!parent?.destinationParent || parent.blockedReason)
				throw new AttachmentImportError("parent-unavailable");
			if (
				!opened?.manifest.entries.some(
					(entry) => entry.source.id === parent.sourceAttachmentId,
				)
			)
				throw new AttachmentImportError("archive-entry-missing");
			selected = parent;
			publish("selected");
		},
		prepare() {
			return run(async () => {
				if (!opened || !selected?.destinationParent || frozen)
					throw new AttachmentImportError("invalid-stage");
				publish("preparing");
				await fingerprint(selected);
				const entry = opened.manifest.entries.find(
					(v) => v.source.id === selected?.sourceAttachmentId,
				);
				if (!entry) throw new AttachmentImportError("archive-entry-missing");
				const parent = selected.destinationParent;
				const key = await wait(ownership().workspaceKey(parent.workspaceId));
				if (
					!key ||
					key.workspaceId !== parent.workspaceId ||
					key.wdk.length !== 32
				)
					throw new AttachmentImportError("locked");
				const wdk = key.wdk.slice();
				try {
					frozen = await wait(
						prepareAttachmentMigration(
							opened,
							entry.entryId,
							{
								workspaceId: parent.workspaceId,
								parentKind: parent.kind,
								parentId: parent.id,
								keyVersion: key.keyVersion,
								wdk,
							},
							{ signal: abort.signal, checkpoint: check },
						),
					);
				} finally {
					wdk.fill(0);
				}
				request = Object.freeze({
					ordinal: selected.ordinal,
					sourceFingerprint: selected.sourceAttachmentFingerprint,
					expectedRevision: 0,
					prepared: Object.freeze({ ...frozen.prepared }),
				});
				publish("prepared");
				return request.prepared;
			});
		},
		transfer() {
			return run(async () => {
				if (state.stage !== "prepared")
					throw new AttachmentImportError("invalid-stage");
				await finish(null);
			});
		},
		reconcile() {
			return run(async () => {
				requirePrepared();
				if (abort.signal.aborted) abort = new AbortController();
				const value = await status();
				if (!value) publish("uncertain", "reservation-not-found");
				else if (!value.committed) {
					mutation = null;
					publish("uncertain", "active-reservation");
				}
				return value;
			}, true);
		},
		retry() {
			return run(async () => {
				requirePrepared();
				if (state.stage === "complete" || state.stage === "recovery-required")
					throw new AttachmentImportError("invalid-stage");
				if (abort.signal.aborted) abort = new AbortController();
				const value = await status();
				if (value?.committed) return;
				await finish(value);
			}, true);
		},
		cancelReservation() {
			return run(async () => {
				if (mutation === "finalize")
					throw new AttachmentImportError("reconcile-before-cancel");
				const value = await status();
				if (!value) throw new AttachmentImportError("recovery-required");
				if (value.committed) return;
				mutation = "upload";
				await wait(
					api.abort(requirePrepared().frozen.prepared.id, abort.signal),
				);
				const confirmed = await wait(
					api.status(
						requirePrepared().request.ordinal,
						{
							attemptId: value.attemptId,
							targetAttachmentId: value.targetAttachmentId,
							revision: value.revision,
						},
						abort.signal,
					),
				);
				if (confirmed.committed) {
					accept(confirmed);
					return;
				}
				if (
					confirmed.associationId !== value.associationId ||
					confirmed.attachmentState !== "aborted"
				)
					throw new MigrationTransportError(
						"cancellation-unconfirmed",
						200,
						true,
					);
				reservation = Object.freeze({ ...confirmed });
				publish("cancelled");
			}, true);
		},
		cancel() {
			if (state.stage === "complete") return;
			abort.abort(
				new DOMException("Attachment import cancelled", "AbortError"),
			);
			publish(
				mutation ? "uncertain" : "cancelled",
				mutation ? "cancellation-unconfirmed" : null,
			);
		},
		dispose() {
			retired = true;
			abort.abort();
			options.signal?.removeEventListener("abort", forwardAbort);
			opened = undefined;
			document = undefined;
			frozen = undefined;
			request = undefined;
			parents.clear();
			publish("retired", "retired");
		},
	};
}
