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
	type MigrationInspection,
	type MigrationParentPage,
	type MigrationRecoveryRequest,
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
	inspection: Readonly<MigrationInspection> | null;
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
	const migration = runtime.attachments?.archiveMigration;
	const archiveInput = runtime.attachments?.archiveInput;
	const browser = runtime === browserE2eRuntime && !runtime.attachments;
	let retired = false,
		busy = false;
	let abort = new AbortController();
	let state: AttachmentImportState = Object.freeze({
		stage: "idle",
		ordinal: null,
		code: null,
		reservation: null,
		inspection: null,
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
	let inspected: MigrationInspection | undefined;
	let recoveryRequest: MigrationRecoveryRequest | undefined;
	let mutation:
		| "recover"
		| "reserve"
		| "upload"
		| "thumbnail"
		| "finalize"
		| null = null;
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
			inspection: inspected
				? Object.freeze({
						...inspected,
						destinationParent: Object.freeze({
							...inspected.destinationParent,
						}),
					})
				: null,
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
			(browser
				? runtime.attachments
				: !migration ||
					!archiveInput ||
					runtime.attachments?.archiveMigration !== migration ||
					runtime.attachments?.archiveInput !== archiveInput)
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
	let api: ReturnType<typeof createAttachmentMigrationApi> | undefined;
	function migrationApi() {
		ownership();
		api ??= migration
			? migration.bind(options.binding)
			: createAttachmentMigrationApi({
					binding: options.binding,
					checkpoint: ownership,
					fetcher: runtime.fetcher,
				});
		return api;
	}
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
				retire(code);
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
			result.revision !==
				(recoveryRequest ? recoveryRequest.previous.revision + 1 : 1) ||
			(reservation &&
				(result.associationId !== reservation.associationId ||
					result.attemptId !== reservation.attemptId ||
					result.revision !== reservation.revision))
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
	function retire(code: string) {
		retired = true;
		abort.abort();
		opened = undefined;
		document = undefined;
		frozen = undefined;
		request = undefined;
		recoveryRequest = undefined;
		inspected = undefined;
		reservation = undefined;
		selected = undefined;
		parents.clear();
		publish("retired", code);
	}
	function expectedInspection() {
		if (!selected?.destinationParent)
			throw new AttachmentImportError("parent-unavailable");
		return {
			sourceFingerprint: selected.sourceAttachmentFingerprint,
			destinationParent: selected.destinationParent,
		};
	}
	async function inspect() {
		if (!selected || !opened) throw new AttachmentImportError("invalid-stage");
		await fingerprint(selected);
		try {
			const result = await wait(
				migrationApi().inspect(
					selected.ordinal,
					expectedInspection(),
					abort.signal,
				),
			);
			inspected = Object.freeze({ ...result });
			if (result.committed) {
				reservation = Object.freeze({ ...result });
				publish("complete");
			} else
				publish(
					"recovery-required",
					result.recoverable ? "recovery-required" : "active-reservation",
				);
			return result;
		} catch (error) {
			if (error instanceof MigrationTransportError && error.status === 404) {
				inspected = undefined;
				publish(frozen ? "prepared" : "selected");
				return null;
			}
			throw error;
		}
	}
	function previousMatches(value: MigrationInspection) {
		const previous = recoveryRequest?.previous;
		return (
			previous &&
			value.associationId === previous.associationId &&
			value.attemptId === previous.attemptId &&
			value.targetAttachmentId === previous.targetAttachmentId &&
			value.revision === previous.revision
		);
	}
	async function replayRecovery() {
		if (!recoveryRequest)
			throw new AttachmentImportError("preparation-required");
		const value = await inspect();
		if (value?.committed) return;
		if (!value) throw new AttachmentImportError("recovery-required");
		if (
			value.targetAttachmentId === recoveryRequest.prepared.id &&
			value.revision === recoveryRequest.previous.revision + 1 &&
			value.associationId === recoveryRequest.previous.associationId
		) {
			reservation = undefined;
			if (accept(value)) return;
			await finish(value);
			return;
		}
		if (!previousMatches(value))
			throw new AttachmentImportError("reservation-identity-mismatch");
		mutation = "recover";
		const result = await wait(
			migrationApi().recover(
				recoveryRequest,
				expectedInspection(),
				abort.signal,
			),
		);
		inspected = result.status;
		reservation = undefined;
		if (result.outcome === "committed") {
			reservation = result.status;
			publish("complete");
			return;
		}
		if (result.outcome === "recovery-required") {
			reservation = Object.freeze({ ...result.status });
			throw new AttachmentImportError("recovery-required");
		}
		if (!accept(result.status)) await finish(result.status);
	}
	async function status() {
		const current = requirePrepared();
		const unacknowledgedNativeReserve =
			migration && mutation === "reserve" && !reservation && !recoveryRequest;
		try {
			const result = await wait(
				unacknowledgedNativeReserve
					? migrationApi().inspect(
							current.request.ordinal,
							expectedInspection(),
							abort.signal,
						)
					: migrationApi().status(
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
				if (unacknowledgedNativeReserve)
					throw new MigrationTransportError(
						"migration-reconciliation-required",
						404,
						true,
					);
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
			existing = await wait(
				migrationApi().reserve(current.request, abort.signal),
			);
			if (accept(existing)) return;
		}
		if (existing.attachmentState === "reserved") {
			mutation = "upload";
			await wait(
				migrationApi().upload(
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
				migrationApi().thumbnail(
					current.frozen.prepared,
					new Blob([
						byteNarrower("attachment import")(current.frozen.thumbnail),
					]),
					abort.signal,
				),
			);
		}
		mutation = "finalize";
		await wait(migrationApi().finalize(current.frozen.prepared, abort.signal));
		const acknowledged = await status();
		if (!acknowledged?.committed)
			throw new MigrationTransportError(
				"acknowledgment-unconfirmed",
				200,
				true,
			);
	}
	async function prepare() {
		if (
			!opened ||
			!selected?.destinationParent ||
			selected.blockedReason ||
			frozen
		)
			throw new AttachmentImportError("invalid-stage");
		publish("preparing");
		await fingerprint(selected);
		const entry = opened.manifest.entries.find(
			(v) => v.source.id === selected?.sourceAttachmentId,
		);
		if (!entry) throw new AttachmentImportError("archive-entry-missing");
		const parent = selected.destinationParent;
		const key = await wait(ownership().workspaceKey(parent.workspaceId));
		if (!key || key.workspaceId !== parent.workspaceId || key.wdk.length !== 32)
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
	}
	return {
		get state() {
			return state;
		},
		get hasPrepared() {
			return frozen !== undefined && request !== undefined;
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
				const page = await wait(migrationApi().parents(query, abort.signal));
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
			if (!parent?.destinationParent)
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
		inspect() {
			return run(inspect, true);
		},
		prepare() {
			return run(async () => {
				if (await inspect()) return null;
				return prepare();
			});
		},
		recover(confirmation: { retireLive: boolean }) {
			return run(async () => {
				const approved = inspected;
				if (!approved) throw new AttachmentImportError("inspection-required");
				const previous = await inspect();
				if (previous?.committed) return;
				if (
					previous &&
					(previous.associationId !== approved.associationId ||
						previous.attemptId !== approved.attemptId ||
						previous.targetAttachmentId !== approved.targetAttachmentId ||
						previous.revision !== approved.revision)
				)
					throw new AttachmentImportError("reservation-identity-mismatch");
				if (
					!previous ||
					!previous.attemptId ||
					!previous.targetAttachmentId ||
					previous.attachmentState === "deleting" ||
					!selected?.destinationParent ||
					selected.blockedReason
				)
					throw new AttachmentImportError("recovery-required");
				if (recoveryRequest) {
					if (
						!previous.recoverable ||
						previous.associationId !== recoveryRequest.previous.associationId ||
						previous.targetAttachmentId !== recoveryRequest.prepared.id ||
						previous.revision !== recoveryRequest.previous.revision + 1 ||
						!reservation ||
						previous.associationId !== reservation.associationId ||
						previous.attemptId !== reservation.attemptId ||
						previous.targetAttachmentId !== reservation.targetAttachmentId ||
						previous.revision !== reservation.revision
					)
						throw new AttachmentImportError("retry-required");
					recoveryRequest = undefined;
				}
				if (!previous.recoverable && !confirmation.retireLive)
					throw new AttachmentImportError("live-abandon-confirmation-required");
				frozen = undefined;
				request = undefined;
				await prepare();
				const current = requirePrepared();
				recoveryRequest = Object.freeze({
					ordinal: current.request.ordinal,
					sourceFingerprint: current.request.sourceFingerprint,
					previous: Object.freeze({
						associationId: previous.associationId,
						attemptId: previous.attemptId,
						targetAttachmentId: previous.targetAttachmentId,
						revision: previous.revision,
					}),
					prepared: current.request.prepared,
					retireLive: confirmation.retireLive,
				});
				reservation = undefined;
				await replayRecovery();
			}, true);
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
				if (!frozen || !request) return inspect();
				if (abort.signal.aborted) abort = new AbortController();
				const value = recoveryRequest ? await inspect() : await status();
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
				if (recoveryRequest) {
					await replayRecovery();
					return;
				}
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
					migrationApi().abort(
						requirePrepared().frozen.prepared.id,
						abort.signal,
					),
				);
				const confirmed = await wait(
					migrationApi().status(
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
			if (retired || state.stage === "complete") return;
			abort.abort(
				new DOMException("Attachment import cancelled", "AbortError"),
			);
			publish(
				mutation ? "uncertain" : "cancelled",
				mutation ? "cancellation-unconfirmed" : null,
			);
		},
		dispose() {
			options.signal?.removeEventListener("abort", forwardAbort);
			retire("retired");
		},
	};
}
