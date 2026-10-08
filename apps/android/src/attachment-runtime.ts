import { z } from "zod";
import { sanitiseFilename } from "../../../src/domain/attachment.ts";
import {
	createAttachmentMigrationApi,
	type MigrationReservation,
	MigrationTransportError,
	migrationBindingSchema,
	migrationJobsPageSchema,
	parseNativeMigrationStatus,
} from "../../../src/web/lib/e2e/attachment-migration-api.ts";
import { withCiphertextStage } from "../../../src/web/lib/e2e/ciphertext-staging.ts";
import {
	type AttachmentFileWriter,
	type CiphertextStageRunner,
	type DownloadDestination,
	FilePickerCancelledError,
} from "../../../src/web/lib/e2e/download.ts";
import type { AttachmentRuntime } from "../../../src/web/lib/e2e/runtime.ts";
import type { E2eFetcher } from "../../../src/web/lib/e2e/workspace-keys.ts";
import { type AttachmentOp, callAttachment, NativeError } from "./bridge.ts";

const CHUNK = 32768;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
type Call = typeof callAttachment;
type Reply = Awaited<ReturnType<Call>>;
function id(reply: Reply, name: string): string {
	const value = reply[name];
	if (typeof value !== "string" || !ID.test(value))
		throw new TypeError("native file capability refused");
	return value;
}
function response(reply: Reply): Response {
	const status = reply.status;
	if (
		typeof status !== "number" ||
		!Number.isInteger(status) ||
		status < 200 ||
		status > 599 ||
		!(reply.body === null || typeof reply.body === "string")
	)
		throw new TypeError("native file response refused");
	return new Response([204, 205, 304].includes(status) ? null : reply.body, {
		status,
		headers: { "content-type": "application/json" },
	});
}
function encode(bytes: Uint8Array): string {
	let value = "";
	for (const byte of bytes) value += String.fromCharCode(byte);
	return btoa(value);
}
function decode(reply: Reply): Uint8Array<ArrayBuffer> {
	if (
		typeof reply.data !== "string" ||
		reply.data.length > 43692 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			reply.data,
		)
	)
		throw new TypeError("native file chunk refused");
	const raw = atob(reply.data);
	if (raw.length > CHUNK || btoa(raw) !== reply.data)
		throw new TypeError("native file chunk refused");
	return Uint8Array.from(raw, (value) => value.charCodeAt(0));
}
async function* chunks(
	input: ReadableStream<Uint8Array>,
	signal?: AbortSignal | null,
): AsyncIterable<Uint8Array> {
	const reader = input.getReader();
	let complete = false;
	try {
		while (true) {
			signal?.throwIfAborted();
			const next = await reader.read();
			if (next.done) {
				complete = true;
				return;
			}
			if (!(next.value instanceof Uint8Array))
				throw new TypeError("native upload bytes refused");
			for (let offset = 0; offset < next.value.length; offset += CHUNK)
				yield next.value.subarray(offset, offset + CHUNK);
		}
	} finally {
		if (!complete) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
function route(
	input: Parameters<E2eFetcher>[0],
	init?: RequestInit,
): {
	op: AttachmentOp;
	body: Record<string, unknown>;
	kind: "control" | "upload" | "download";
} {
	if (typeof input !== "string" || /[?#\\%]/.test(input))
		throw new TypeError("native attachment target refused");
	for (const [name] of new Headers(init?.headers))
		if (!["content-type", "accept"].includes(name))
			throw new TypeError("native attachment headers refused");
	const method = (init?.method ?? "GET").toUpperCase();
	if (input === "/api/attachments/config" && method === "GET" && !init?.body)
		return { op: "attachment.config", body: {}, kind: "control" };
	const control = /^\/api\/attachments\/(reserve|finalize|abort|delete)$/.exec(
		input,
	);
	if (
		control &&
		method === "POST" &&
		typeof init?.body === "string" &&
		new TextEncoder().encode(init.body).length <= 2 * 1024 * 1024
	) {
		const body: unknown = JSON.parse(init.body);
		if (!body || typeof body !== "object" || Array.isArray(body))
			throw new TypeError("native attachment body refused");
		return {
			op: `attachment.${control[1]}` as
				| "attachment.reserve"
				| "attachment.finalize"
				| "attachment.abort"
				| "attachment.delete",
			body: Object.fromEntries(Object.entries(body)),
			kind: "control",
		};
	}
	const item =
		/^\/api\/attachments\/([A-Za-z0-9_-]{1,128})(?:\/(upload|thumbnail|download))?$/.exec(
			input,
		);
	if (item) {
		const attachmentId = item[1];
		const suffix = item[2];
		if ((suffix === "upload" || suffix === "thumbnail") && method === "POST")
			return {
				op: "upload.begin",
				body: { attachmentId, thumbnail: suffix === "thumbnail" },
				kind: "upload",
			};
		if (
			(suffix === "download" || suffix === "thumbnail") &&
			method === "GET" &&
			!init?.body
		)
			return {
				op: "download.begin",
				body: { attachmentId, thumbnail: suffix === "thumbnail" },
				kind: "download",
			};
	}
	throw new TypeError("native attachment target refused");
}

/** Bound to one verified account. Native owns all URLs, credentials and paths. */
export function createAttachmentRuntime(
	assertCurrent: () => void,
	scope: string,
	desktop: boolean,
	call: Call = callAttachment,
	archiveExportEnabled = false,
	archiveInputEnabled = false,
	archiveMigrationEnabled = false,
	ownerId?: string,
): AttachmentRuntime {
	const declared = new Map<string, number>();
	const checked: Call = async (op, body = {}) => {
		assertCurrent();
		const result = await call(op, body);
		assertCurrent();
		return result;
	};
	const cancel = async (op: AttachmentOp, body: Record<string, unknown>) => {
		// Retired native owners already cancel every capability. Never address a replacement.
		try {
			await checked(op, body);
		} catch {
			/* Cleanup cannot replace the original failure. */
		}
	};
	const fetcher: E2eFetcher = async (input, init) => {
		assertCurrent();
		init?.signal?.throwIfAborted();
		const resolved = route(input, init);
		if (resolved.kind === "control") {
			const result = response(await checked(resolved.op, resolved.body));
			init?.signal?.throwIfAborted();
			if (resolved.op === "attachment.reserve" && result.ok) {
				const body = resolved.body;
				if (
					typeof body.id !== "string" ||
					!ID.test(body.id) ||
					!Number.isSafeInteger(body.declaredBytes) ||
					Number(body.declaredBytes) <= 0
				)
					throw new TypeError("native upload size refused");
				declared.set(`${body.id}:false`, Number(body.declaredBytes));
				if (body.thumbnailDeclaredBytes != null) {
					if (
						!Number.isSafeInteger(body.thumbnailDeclaredBytes) ||
						Number(body.thumbnailDeclaredBytes) <= 0
					)
						throw new TypeError("native thumbnail size refused");
					declared.set(`${body.id}:true`, Number(body.thumbnailDeclaredBytes));
				}
			}
			if (
				[
					"attachment.finalize",
					"attachment.abort",
					"attachment.delete",
				].includes(resolved.op)
			) {
				declared.delete(`${resolved.body.id}:false`);
				declared.delete(`${resolved.body.id}:true`);
			}
			return result;
		}
		if (resolved.kind === "upload") {
			const bytes = declared.get(
				`${resolved.body.attachmentId}:${resolved.body.thumbnail}`,
			);
			if (!bytes || !(init?.body instanceof ReadableStream))
				throw new TypeError("native upload requires reserved streaming bytes");
			const begun = await checked("upload.begin", { ...resolved.body, bytes });
			if (!begun.ok) return response(begun);
			const transferId = id(begun, "transferId");
			const abort = () => {
				void cancel("attachment.cancel", { transferId });
			};
			init.signal?.addEventListener("abort", abort, { once: true });
			let seq = 0;
			try {
				init.signal?.throwIfAborted();
				for await (const chunk of chunks(init.body, init.signal)) {
					await checked("upload.write", {
						transferId,
						seq: seq++,
						data: encode(chunk),
					});
					init.signal?.throwIfAborted();
				}
				return response(await checked("upload.finish", { transferId, seq }));
			} finally {
				init.signal?.removeEventListener("abort", abort);
				await cancel("attachment.cancel", { transferId });
			}
		}
		const begun = await checked("download.begin", resolved.body);
		if (!begun.ok) return response(begun);
		const transferId = id(begun, "transferId");
		const status = begun.status;
		if (
			typeof status !== "number" ||
			status < 200 ||
			status > 299 ||
			!Number.isInteger(status)
		) {
			await cancel("attachment.cancel", { transferId });
			throw new TypeError("native download response refused");
		}
		let seq = 0;
		let retired = false;
		const finish = async () => {
			if (retired) return;
			retired = true;
			init?.signal?.removeEventListener("abort", abort);
			await cancel("attachment.cancel", { transferId });
		};
		let streamController: ReadableStreamDefaultController<Uint8Array>;
		const abort = () => {
			if (!retired)
				streamController.error(
					init?.signal?.reason ?? new DOMException("Aborted", "AbortError"),
				);
			void finish();
		};
		const stream = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					streamController = controller;
					init?.signal?.addEventListener("abort", abort, { once: true });
					if (init?.signal?.aborted) abort();
				},
				async pull(controller) {
					if (retired) return;
					try {
						const reply = await checked("download.read", {
							transferId,
							seq: seq++,
						});
						if (retired) return;
						if (typeof reply.eof !== "boolean")
							throw new TypeError("native download end refused");
						const data = decode(reply);
						if (reply.eof) {
							if (data.length)
								throw new TypeError("native download trailing data refused");
							controller.close();
							await finish();
						} else {
							if (!data.length)
								throw new TypeError("native download empty chunk refused");
							controller.enqueue(data);
						}
					} catch (error) {
						if (!retired) controller.error(error);
						await finish();
					}
				},
				cancel: finish,
			},
			{ highWaterMark: 0 },
		);
		const headers = new Headers();
		if (
			typeof begun.bytes === "number" &&
			Number.isSafeInteger(begun.bytes) &&
			begun.bytes >= 0
		)
			headers.set("content-length", String(begun.bytes));
		return new Response(stream, { status, headers });
	};

	function writer(
		capability: string,
		kind: "save" | "stage",
	): AttachmentFileWriter {
		let seq = 0;
		let closed = false;
		const key = kind === "save" ? "saveId" : "stageId";
		return {
			async write(chunk) {
				if (closed) throw new TypeError("native file writer closed");
				for (let offset = 0; offset < chunk.length; offset += CHUNK)
					await checked(`${kind}.write`, {
						[key]: capability,
						seq: seq++,
						data: encode(chunk.subarray(offset, offset + CHUNK)),
					});
			},
			async close() {
				if (closed) throw new TypeError("native file writer closed");
				if (kind === "save")
					await checked("save.finish", { saveId: capability, seq });
				closed = true;
			},
			async abort() {
				closed = true;
				await cancel(`${kind}.cancel`, { [key]: capability });
			},
		};
	}
	let picking = false;
	const pickFile = async (
		filename: string,
		signal?: AbortSignal,
	): Promise<DownloadDestination> => {
		signal?.throwIfAborted();
		if (picking) throw new TypeError("native file picker busy");
		picking = true;
		let saveId: string;
		let rejectAbort: ((error: unknown) => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			rejectAbort = reject;
		});
		const abort = () => {
			void cancel("save.cancelPending", {});
			rejectAbort?.(
				signal?.reason ?? new DOMException("Aborted", "AbortError"),
			);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			const picked = checked("save.pick", {
				filename: sanitiseFilename(filename).slice(0, 255),
			}).then(async (reply) => {
				const capability = id(reply, "saveId");
				if (signal?.aborted) {
					await cancel("save.cancel", { saveId: capability });
					signal.throwIfAborted();
				}
				return capability;
			});
			saveId = await Promise.race([picked, aborted]);
		} catch (error) {
			await cancel("save.cancelPending", {});
			assertCurrent();
			signal?.throwIfAborted();
			if (error instanceof NativeError && error.code === "cancelled")
				throw new FilePickerCancelledError();
			throw error;
		} finally {
			picking = false;
			signal?.removeEventListener("abort", abort);
		}
		let opened = false;
		return {
			async createWritable() {
				assertCurrent();
				signal?.throwIfAborted();
				if (opened) throw new TypeError("native file writer already opened");
				opened = true;
				return writer(saveId, "save");
			},
			async cancel() {
				await cancel("save.cancel", { saveId });
			},
		};
	};
	const withStage: CiphertextStageRunner = desktop
		? async (use) => {
				const stageId = id(await checked("stage.begin", {}), "stageId");
				let written = false;
				try {
					return await use({
						async createWritable() {
							if (written) throw new TypeError("native stage already written");
							written = true;
							return writer(stageId, "stage");
						},
						async getFile() {
							return {
								stream() {
									let seq = 0;
									return new ReadableStream<Uint8Array>(
										{
											async start() {
												await checked("stage.rewind", { stageId });
											},
											async pull(controller) {
												const reply = await checked("stage.read", {
													stageId,
													seq: seq++,
												});
												if (typeof reply.eof !== "boolean")
													throw new TypeError("native stage end refused");
												const data = decode(reply);
												if (reply.eof) {
													if (data.length)
														throw new TypeError(
															"native stage trailing data refused",
														);
													controller.close();
												} else {
													if (!data.length)
														throw new TypeError(
															"native stage empty chunk refused",
														);
													controller.enqueue(data);
												}
											},
										},
										{ highWaterMark: 0 },
									);
								},
							};
						},
					});
				} finally {
					await cancel("stage.cancel", { stageId });
				}
			}
		: (use) => withCiphertextStage(use, scope);
	let archiveReading = false;
	const archiveExport =
		desktop && archiveExportEnabled
			? {
					async readContent(signal?: AbortSignal): Promise<string> {
						assertCurrent();
						signal?.throwIfAborted();
						if (archiveReading) throw new Error("native archive export busy");
						archiveReading = true;
						let transferId: string | undefined;
						const abort = () => {
							void cancel(
								transferId
									? "attachment.cancel"
									: "archive.export.cancelPending",
								transferId ? { transferId } : {},
							);
						};
						signal?.addEventListener("abort", abort, { once: true });
						try {
							const begun = await checked("archive.export.begin", {});
							if (!begun.ok)
								throw new Error(
									begun.status === 413
										? "archive-too-large"
										: begun.status === 429
											? "export-busy"
											: begun.status === 401
												? "unauthorized"
												: "archive-export-refused",
								);
							transferId = id(begun, "transferId");
							if (
								!Number.isSafeInteger(begun.bytes) ||
								Number(begun.bytes) < 0 ||
								Number(begun.bytes) > 32 * 1024 * 1024
							)
								throw new TypeError("native archive size refused");
							const expected = Number(begun.bytes);
							const decoder = new TextDecoder("utf-8", {
								fatal: true,
								ignoreBOM: true,
							});
							const parts: string[] = [];
							let seen = 0;
							for (let seq = 0; ; seq++) {
								signal?.throwIfAborted();
								const next = await checked("archive.export.read", {
									transferId,
									seq,
								});
								signal?.throwIfAborted();
								if (!next.ok || typeof next.eof !== "boolean")
									throw new TypeError("native archive response refused");
								const bytes = decode(next);
								seen += bytes.length;
								if (seen > expected || (!next.eof && bytes.length === 0))
									throw new TypeError("native archive size refused");
								parts.push(decoder.decode(bytes, { stream: !next.eof }));
								if (next.eof) {
									if (bytes.length !== 0 || seen !== expected)
										throw new TypeError("native archive size refused");
									assertCurrent();
									return parts.join("");
								}
							}
						} finally {
							signal?.removeEventListener("abort", abort);
							if (transferId) await cancel("attachment.cancel", { transferId });
							else await cancel("archive.export.cancelPending", {});
							archiveReading = false;
						}
					},
				}
			: undefined;
	let inputReading = false;
	const archiveInput: AttachmentRuntime["archiveInput"] =
		desktop && archiveInputEnabled
			? {
					async readDocument(kind, signal) {
						assertCurrent();
						signal?.throwIfAborted();
						if (kind !== "content" && kind !== "archive")
							throw new TypeError("native archive kind refused");
						if (inputReading) throw new Error("native archive input busy");
						inputReading = true;
						let transferId: string | undefined;
						let rejectAbort: (reason: unknown) => void = () => {};
						const aborted = new Promise<never>((_, reject) => {
							rejectAbort = reject;
						});
						const abort = () => {
							void cancel(
								transferId
									? "archive.input.cancel"
									: "archive.input.cancelPending",
								transferId ? { transferId } : {},
							);
							rejectAbort(
								signal?.reason ?? new DOMException("Aborted", "AbortError"),
							);
						};
						signal?.addEventListener("abort", abort, { once: true });
						try {
							const picked = checked("archive.input.pick", { kind }).then(
								async (reply) => {
									if (!reply.ok)
										throw new TypeError("native archive input refused");
									transferId = id(reply, "transferId");
									if (signal?.aborted) {
										await cancel("archive.input.cancel", { transferId });
										signal.throwIfAborted();
									}
									return reply;
								},
								(error: unknown) => {
									assertCurrent();
									signal?.throwIfAborted();
									if (
										error instanceof NativeError &&
										error.code === "cancelled"
									)
										return null;
									throw error;
								},
							);
							const begun = await Promise.race([picked, aborted]);
							assertCurrent();
							signal?.throwIfAborted();
							if (begun === null) return null;
							if (
								typeof begun.bytes !== "number" ||
								!Number.isSafeInteger(begun.bytes) ||
								begun.bytes < 0 ||
								begun.bytes > 32 * 1024 * 1024
							)
								throw new TypeError("native archive size refused");
							if (
								typeof begun.name !== "string" ||
								sanitiseFilename(begun.name) !== begun.name ||
								new TextEncoder().encode(begun.name).length > 255
							)
								throw new TypeError("native archive name refused");
							const decoder = new TextDecoder("utf-8", {
								fatal: true,
								ignoreBOM: true,
							});
							const parts: string[] = [];
							let seen = 0;
							for (let seq = 0; ; seq++) {
								signal?.throwIfAborted();
								const next = await Promise.race([
									checked("archive.input.read", { transferId, seq }),
									aborted,
								]);
								signal?.throwIfAborted();
								if (!next.ok || typeof next.eof !== "boolean")
									throw new TypeError("native archive response refused");
								const bytes = decode(next);
								seen += bytes.length;
								if (seen > begun.bytes || (!next.eof && !bytes.length))
									throw new TypeError("native archive size refused");
								if (next.eof && (bytes.length !== 0 || seen !== begun.bytes))
									throw new TypeError("native archive size refused");
								parts.push(decoder.decode(bytes, { stream: !next.eof }));
								if (next.eof) {
									assertCurrent();
									return Object.freeze({
										text: parts.join(""),
										name: begun.name,
									});
								}
							}
						} finally {
							signal?.removeEventListener("abort", abort);
							await cancel(
								transferId
									? "archive.input.cancel"
									: "archive.input.cancelPending",
								transferId ? { transferId } : {},
							);
							inputReading = false;
						}
					},
				}
			: undefined;
	type Fence = { target: string; operation: string; record?: string };
	const fencedJobs = new Map<string, Fence>();
	const activeWrites = new Set<string>();
	const pendingMutations = new Map<string, number>();
	type Retained = {
		ordinal: number;
		associationId?: string;
		sourceFingerprint: string;
		revision: number;
		reservation?: MigrationReservation;
		prepared?: string;
	};
	function retainedWitness(record?: Retained) {
		if (!record) return undefined;
		return JSON.stringify({
			ordinal: record.ordinal,
			sourceFingerprint: record.sourceFingerprint,
			revision: record.revision,
			associationId: record.associationId,
			prepared: record.prepared,
		});
	}
	function preparedWitness(prepared: object) {
		return JSON.stringify(
			Object.entries(prepared).sort(([a], [b]) => a.localeCompare(b)),
		);
	}
	const retainedJobs = new Map<string, Map<string, Retained>>();
	const admittedBindings = new Map<string, string>();
	async function migrationCall(
		op: AttachmentOp,
		body: Record<string, unknown>,
		signal?: AbortSignal,
		jobId?: string,
	) {
		assertCurrent();
		signal?.throwIfAborted();
		const mutation =
			jobId &&
			[
				"archive.migration.reserve",
				"archive.migration.recover",
				"attachment.finalize",
				"attachment.abort",
			].includes(op);
		if (mutation)
			pendingMutations.set(jobId, (pendingMutations.get(jobId) ?? 0) + 1);
		const dispatched = checked(op, body).finally(() => {
			if (mutation)
				pendingMutations.set(jobId, (pendingMutations.get(jobId) ?? 1) - 1);
		});
		let abort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			abort = () =>
				reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
			signal?.addEventListener("abort", abort, { once: true });
		});
		try {
			return await Promise.race([dispatched, aborted]);
		} finally {
			if (abort) signal?.removeEventListener("abort", abort);
		}
	}
	const archiveMigration: AttachmentRuntime["archiveMigration"] =
		desktop && archiveMigrationEnabled && ownerId
			? {
					async jobs(query, signal) {
						const q = z
							.strictObject({
								limit: z.number().int().min(1).max(64),
								afterJobId: z
									.string()
									.regex(/^[a-f0-9]{64}$/)
									.optional(),
							})
							.parse(query);
						const reply = await migrationCall(
							"archive.migration.jobs",
							q,
							signal,
						);
						const result = response(reply);
						if (
							!result.ok ||
							typeof reply.body !== "string" ||
							new TextEncoder().encode(reply.body).length > 65536
						)
							throw new MigrationTransportError(
								"invalid-response",
								result.status,
								false,
							);
						const page = migrationJobsPageSchema.parse(JSON.parse(reply.body));
						let previous = q.afterJobId ?? "";
						for (const item of page.items) {
							if (
								item.ownerId !== ownerId ||
								item.jobId !== item.planDigest ||
								item.jobId <= previous
							)
								throw new MigrationTransportError(
									"migration-binding-mismatch",
									200,
									false,
								);
							previous = item.jobId;
						}
						if (
							page.items.length > q.limit ||
							(page.nextAfterJobId !== null &&
								(!page.items.length || page.nextAfterJobId !== previous))
						)
							throw new MigrationTransportError(
								"parent-cursor-mismatch",
								200,
								false,
							);
						assertCurrent();
						signal?.throwIfAborted();
						for (const item of page.items) {
							const { label: _, ...binding } = item;
							admittedBindings.set(item.jobId, JSON.stringify(binding));
						}
						return page;
					},
					bind(input) {
						assertCurrent();
						const binding = migrationBindingSchema.parse(input);
						if (
							binding.ownerId !== ownerId ||
							admittedBindings.get(binding.jobId) !== JSON.stringify(binding)
						)
							throw new MigrationTransportError(
								"migration-binding-mismatch",
								null,
								false,
							);
						const jobId = binding.jobId;
						const records =
							retainedJobs.get(jobId) ?? new Map<string, Retained>();
						retainedJobs.set(jobId, records);
						const trackedUpload: Call = (op, body) => {
							pendingMutations.set(
								jobId,
								(pendingMutations.get(jobId) ?? 0) + 1,
							);
							return checked(op, body).finally(() => {
								pendingMutations.set(
									jobId,
									(pendingMutations.get(jobId) ?? 1) - 1,
								);
							});
						};
						const nativeFetcher: E2eFetcher = async (path, init) => {
							if (typeof path !== "string")
								throw new TypeError("native migration target refused");
							const signal = init?.signal ?? undefined;
							const body =
								typeof init?.body === "string"
									? JSON.parse(init.body)
									: undefined;
							const base = `/api/portability/import/plans/${jobId}`;
							let op: AttachmentOp;
							let payload: Record<string, unknown>;
							if (path.startsWith(`${base}/`)) {
								const url = new URL(path, "https://native.invalid");
								const action = url.pathname.slice(base.length + 1);
								if (action === "attachment-parents") {
									op = "archive.migration.parents";
									payload = {
										jobId,
										afterOrdinal: Number(url.searchParams.get("afterOrdinal")),
										limit: Number(url.searchParams.get("limit")),
									};
								} else if (action === "attachment-migrations") {
									op = "archive.migration.inspect";
									payload = {
										jobId,
										ordinal: Number(url.searchParams.get("ordinal")),
									};
								} else if (
									action === "attachment-reservations" &&
									init?.method !== "POST"
								) {
									op = "archive.migration.status";
									payload = {
										jobId,
										ordinal: Number(url.searchParams.get("ordinal")),
									};
								} else if (action === "attachment-reservations") {
									op = "archive.migration.reserve";
									payload = { jobId, reservation: body };
								} else if (action === "attachment-recoveries") {
									op = "archive.migration.recover";
									payload = { jobId, recovery: body };
								} else throw new TypeError("native migration target refused");
							} else if (
								path === "/api/attachments/finalize" ||
								path === "/api/attachments/abort"
							) {
								op = path.endsWith("finalize")
									? "attachment.finalize"
									: "attachment.abort";
								requireTarget(body.id);
								payload = body;
							} else {
								const match =
									/^\/api\/attachments\/(migration_[a-f0-9-]+)\/(upload|thumbnail)$/.exec(
										path,
									);
								const record = match && records.get(match[1]);
								if (!record?.reservation || !(init?.body instanceof Blob))
									throw new TypeError("native migration witness required");
								const thumbnail = match?.[2] === "thumbnail";
								const witness = record.reservation;
								const pending = trackedUpload(
									"archive.migration.upload.begin",
									{
										jobId,
										ordinal: record.ordinal,
										associationId: witness.associationId,
										attemptId: witness.attemptId,
										targetAttachmentId: witness.targetAttachmentId,
										revision: witness.revision,
										thumbnail,
									},
								).then(async (reply) => {
									if (signal?.aborted && reply.ok)
										await cancel("attachment.cancel", {
											transferId: id(reply, "transferId"),
										});
									return reply;
								});
								let onAbort: (() => void) | undefined;
								const aborted = new Promise<never>((_, reject) => {
									onAbort = () =>
										reject(
											signal?.reason ??
												new DOMException("Aborted", "AbortError"),
										);
									signal?.addEventListener("abort", onAbort, { once: true });
								});
								let transferId: string | undefined;
								try {
									const begun = await Promise.race([pending, aborted]);
									if (!begun.ok) return response(begun);
									transferId = id(begun, "transferId");
									let seq = 0;
									let count = 0;
									for await (const chunk of chunks(
										init.body.stream(),
										signal,
									)) {
										count += chunk.length;
										if (count > init.body.size)
											throw new TypeError("native migration size refused");
										await Promise.race([
											trackedUpload("upload.write", {
												transferId,
												seq: seq++,
												data: encode(chunk),
											}),
											aborted,
										]);
									}
									if (count !== init.body.size)
										throw new TypeError("native migration size refused");
									return response(
										await Promise.race([
											trackedUpload("upload.finish", { transferId, seq }),
											aborted,
										]),
									);
								} finally {
									if (onAbort) signal?.removeEventListener("abort", onAbort);
									if (transferId)
										await cancel("attachment.cancel", { transferId });
								}
							}
							const reply = await migrationCall(op, payload, signal, jobId);
							if (op === "archive.migration.status" && reply.ok) {
								if (
									typeof reply.body !== "string" ||
									new TextEncoder().encode(reply.body).length > 16384
								)
									throw new TypeError("native migration status refused");
								const status = parseNativeMigrationStatus(
									JSON.parse(String(reply.body)),
								);
								const { upload: _, ...ordinary } = status;
								return response({ ...reply, body: JSON.stringify(ordinary) });
							}
							return response(reply);
						};
						const api = createAttachmentMigrationApi({
							binding,
							checkpoint: assertCurrent,
							fetcher: nativeFetcher,
						});
						function requireTarget(target: string) {
							const record = records.get(target);
							if (
								!record?.reservation ||
								record.reservation.targetAttachmentId !== target
							)
								throw new MigrationTransportError(
									"migration-binding-mismatch",
									null,
									false,
								);
							return record;
						}
						function requirePrepared(prepared: { id: string }) {
							const record = requireTarget(prepared.id);
							if (
								record.prepared &&
								record.prepared !== preparedWitness(prepared)
							)
								throw new MigrationTransportError(
									"migration-binding-mismatch",
									null,
									false,
								);
							record.prepared ??= preparedWitness(prepared);
						}
						async function write<T>(
							target: string,
							operation: string,
							run: () => Promise<T>,
						) {
							assertCurrent();
							if (
								fencedJobs.has(jobId) ||
								activeWrites.has(jobId) ||
								pendingMutations.get(jobId)
							)
								throw new MigrationTransportError(
									"migration-reconciliation-required",
									null,
									false,
								);
							activeWrites.add(jobId);
							try {
								return await run();
							} catch (error) {
								if (error instanceof MigrationTransportError && error.uncertain)
									fencedJobs.set(jobId, {
										target,
										operation,
										record: retainedWitness(records.get(target)),
									});
								throw error;
							} finally {
								activeWrites.delete(jobId);
							}
						}
						return {
							parents: api.parents,
							async reserve(input, signal) {
								return write(input.prepared.id, "reserve", async () => {
									const resultPromise = api.reserve(input, signal);
									const retained: Retained = {
										ordinal: input.ordinal,
										prepared: preparedWitness(input.prepared),
										sourceFingerprint: input.sourceFingerprint,
										revision: input.expectedRevision || 1,
									};
									records.set(input.prepared.id, retained);
									const result = await resultPromise;
									retained.reservation = result;
									return result;
								});
							},
							async recover(input, expected, signal) {
								return write(input.prepared.id, "recover", async () => {
									const resultPromise = api.recover(input, expected, signal);
									const retained: Retained = {
										ordinal: input.ordinal,
										prepared: preparedWitness(input.prepared),
										sourceFingerprint: input.sourceFingerprint,
										revision: input.previous.revision + 1,
										associationId: input.previous.associationId,
									};
									records.set(input.prepared.id, retained);
									const result = await resultPromise;
									if (result.status.targetAttachmentId === input.prepared.id)
										retained.reservation = result.status;
									return result;
								});
							},
							async inspect(value, expected, signal) {
								const fence = fencedJobs.get(jobId);
								const settledBeforeRead =
									!pendingMutations.get(jobId) && !activeWrites.has(jobId);
								const result = await api.inspect(value, expected, signal);
								const record =
									result.targetAttachmentId &&
									records.get(result.targetAttachmentId);
								if (
									record &&
									record.ordinal === value &&
									record.sourceFingerprint === result.sourceFingerprint &&
									record.revision === result.revision &&
									(!record.associationId ||
										record.associationId === result.associationId) &&
									(!record.reservation ||
										(record.reservation.associationId ===
											result.associationId &&
											record.reservation.attemptId === result.attemptId))
								) {
									const exactFence =
										fence &&
										fencedJobs.get(jobId) === fence &&
										fence.target === result.targetAttachmentId &&
										fence.record === retainedWitness(record);
									record.reservation = result;
									if (
										settledBeforeRead &&
										!pendingMutations.get(jobId) &&
										exactFence
									)
										fencedJobs.delete(jobId);
								} else if (
									!fencedJobs.has(jobId) &&
									result.targetAttachmentId
								) {
									records.set(result.targetAttachmentId, {
										ordinal: value,
										sourceFingerprint: result.sourceFingerprint,
										revision: result.revision,
										associationId: result.associationId,
										reservation: result,
									});
								}
								return result;
							},
							async status(value, expected, signal) {
								const fence = fencedJobs.get(jobId);
								const settledBeforeRead =
									!pendingMutations.get(jobId) && !activeWrites.has(jobId);
								const record = [...records.values()].find(
									(r) =>
										r.ordinal === value &&
										r.reservation &&
										(!expected ||
											r.reservation.targetAttachmentId ===
												expected.targetAttachmentId),
								);
								const result = await api.status(
									value,
									expected ?? record?.reservation,
									signal,
								);
								if (
									record?.reservation &&
									result.associationId === record.reservation.associationId &&
									result.attemptId === record.reservation.attemptId &&
									result.targetAttachmentId ===
										record.reservation.targetAttachmentId &&
									result.revision === record.reservation.revision
								) {
									const exactFence =
										fence &&
										fencedJobs.get(jobId) === fence &&
										fence.target === result.targetAttachmentId &&
										fence.record === retainedWitness(record);
									record.reservation = result;
									if (
										settledBeforeRead &&
										!pendingMutations.get(jobId) &&
										exactFence
									)
										fencedJobs.delete(jobId);
								}
								return result;
							},
							upload: (prepared, body, signal) =>
								write(prepared.id, "upload", () => {
									requirePrepared(prepared);
									return api.upload(prepared, body, signal);
								}),
							thumbnail: (prepared, body, signal) =>
								write(prepared.id, "thumbnail", () => {
									requirePrepared(prepared);
									return api.thumbnail(prepared, body, signal);
								}),
							finalize: (prepared, signal) =>
								write(prepared.id, "finalize", () => {
									requirePrepared(prepared);
									return api.finalize(prepared, signal);
								}),
							abort: (id, signal) =>
								write(id, "abort", () => {
									requireTarget(id);
									return api.abort(id, signal);
								}),
						};
					},
				}
			: undefined;
	return {
		fetcher,
		pickFile,
		withStage,
		...(archiveExport ? { archiveExport } : {}),
		...(archiveInput ? { archiveInput } : {}),
		...(archiveMigration ? { archiveMigration } : {}),
	};
}
